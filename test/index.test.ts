import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionStartEvent,
    ToolCallEvent,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import setup, { getHookRegistry, loadHooksRegistry, loadUserHooksRegistry, type HookRegistry } from "../src/index.ts"

type BeforeAgentStartEvent = {
    type: "before_agent_start"
    prompt: string
    images?: unknown[]
    systemPrompt: string
    systemPromptOptions: unknown
}

type UserBashEvent = {
    type: "user_bash"
    command: string
    excludeFromContext: boolean
    cwd: string
}

type InputEvent = {
    type: "input"
    text: string
    images?: unknown[]
    source: "interactive" | "rpc" | "extension"
    streamingBehavior?: "steer" | "followUp"
}

type ToolExecutionStartEvent = {
    type: "tool_execution_start"
    toolCallId: string
    toolName: string
    args: unknown
}

type ToolExecutionUpdateEvent = {
    type: "tool_execution_update"
    toolCallId: string
    toolName: string
    args: unknown
    partialResult: unknown
}

type ToolExecutionEndEvent = {
    type: "tool_execution_end"
    toolCallId: string
    toolName: string
    result: unknown
    isError: boolean
}

const tempDirs: string[] = []

async function makeTempHome() {
    const homeDir = await mkdtemp(join(tmpdir(), "pi-hooks-"))
    tempDirs.push(homeDir)
    await mkdir(join(homeDir, ".pi"), { recursive: true })
    return homeDir
}

function createExtensionApiDouble() {
    const handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>> = {}
    const pi = {
        on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
            handlers[event] = handler
        },
    } as ExtensionAPI

    return { pi, handlers }
}

function getSessionStartHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.session_start as ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined
}

function getBeforeAgentStartHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.before_agent_start as
        | ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getUserBashHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.user_bash as
        | ((event: UserBashEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getInputHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.input as ((event: InputEvent, ctx: ExtensionContext) => Promise<void> | undefined) | undefined
}

function getToolCallHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.tool_call as ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<void>) | undefined
}

function getToolResultHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.tool_result as
        | ((event: ToolResultEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolExecutionStartHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.tool_execution_start as
        | ((event: ToolExecutionStartEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolExecutionUpdateHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.tool_execution_update as
        | ((event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolExecutionEndHandler(
    handlers: Partial<Record<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>>,
) {
    return handlers.tool_execution_end as
        | ((event: ToolExecutionEndEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function createNodeHookCommand(outputPath: string) {
    return `node --input-type=module -e "import('node:fs').then(fs=>{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[1],input);});});" ${JSON.stringify(outputPath)}`
}

function createNodeCwdCommand(outputPath: string) {
    return `node --input-type=module -e "import('node:fs').then(fs=>fs.writeFileSync(process.argv[1],process.cwd()));" ${JSON.stringify(outputPath)}`
}

function createExtensionContext(cwd: string) {
    return { cwd } as ExtensionContext
}

describe("pi hooks loader", () => {
    afterEach(async () => {
        const { rm } = await import("node:fs/promises")
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    })

    it("loads one user-level hooks.json into the registry", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            hooks: [
                                {
                                    type: "command",
                                    command: "echo hello",
                                    statusMessage: "running",
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const registry = await loadUserHooksRegistry({ homeDir })
        const expectedSourcePath = join(homeDir, ".pi", "hooks.json")

        expect(registry).toEqual<HookRegistry>({
            files: [
                {
                    sourcePath: expectedSourcePath,
                    events: [
                        {
                            eventName: "session_start",
                            matcherGroups: [
                                {
                                    matcher: undefined,
                                    normalizedMatcher: { kind: "all" },
                                    hooks: [
                                        {
                                            enabled: true,
                                            type: "command",
                                            command: "echo hello",
                                            statusMessage: "running",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        })
    })

    it("normalizes omitted, empty, and star matchers as match-all", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        { hooks: [{ type: "command", command: "echo omitted" }] },
                        { matcher: "", hooks: [{ type: "command", command: "echo empty" }] },
                        { matcher: "*", hooks: [{ type: "command", command: "echo star" }] },
                    ],
                },
            }),
        )

        const registry = await loadUserHooksRegistry({ homeDir })

        expect(registry.files[0]?.events[0]?.matcherGroups.map((group) => group.normalizedMatcher)).toEqual([
            { kind: "all" },
            { kind: "all" },
            { kind: "all" },
        ])
    })

    it("preserves schema-defined event names and configured order", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            hooks: [
                                { type: "command", command: "echo first" },
                                { type: "command", command: "echo second" },
                            ],
                        },
                    ],
                    turn_end: [
                        {
                            hooks: [{ type: "command", command: "echo third" }],
                        },
                    ],
                },
            }),
        )

        const registry = await loadUserHooksRegistry({ homeDir })

        expect(registry.files[0]?.events.map((event) => event.eventName)).toEqual(["session_start", "turn_end"])
        expect(registry.files[0]?.events[0]?.matcherGroups[0]?.hooks.map((hook) => hook.command)).toEqual([
            "echo first",
            "echo second",
        ])
    })

    it("normalizes literal, exact-alternative, and regex matchers during loading", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        { matcher: "read", hooks: [{ type: "command", command: "echo literal" }] },
                        { matcher: "edit|write", hooks: [{ type: "command", command: "echo alternatives" }] },
                        { matcher: "^read$", hooks: [{ type: "command", command: "echo regex" }] },
                    ],
                },
            }),
        )

        const registry = await loadUserHooksRegistry({ homeDir })

        expect(registry.files[0]?.events[0]?.matcherGroups.map((group) => group.normalizedMatcher)).toEqual([
            { kind: "exact", values: ["read"] },
            { kind: "exact", values: ["edit", "write"] },
            { kind: "regex", pattern: "^read$" },
        ])
    })

    it("treats non-metacharacter literals like read-file as exact matchers", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [{ matcher: "read-file", hooks: [{ type: "command", command: "echo literal" }] }],
                },
            }),
        )

        const registry = await loadUserHooksRegistry({ homeDir })

        expect(registry.files[0]?.events[0]?.matcherGroups[0]?.normalizedMatcher).toEqual({
            kind: "exact",
            values: ["read-file"],
        })
    })

    it("warns and skips matcher groups with invalid regex patterns", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        { matcher: "[", hooks: [{ type: "command", command: "echo bad" }] },
                        { matcher: "read", hooks: [{ type: "command", command: "echo good" }] },
                    ],
                },
            }),
        )

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            const registry = await loadUserHooksRegistry({ homeDir })

            expect(registry.files[0]?.events[0]?.matcherGroups).toHaveLength(1)
            expect(registry.files[0]?.events[0]?.matcherGroups[0]?.normalizedMatcher).toEqual({
                kind: "exact",
                values: ["read"],
            })
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Invalid matcher.*\[/))
        } finally {
            warn.mockRestore()
        }
    })

    it("warns and skips a malformed user-level hooks.json", async () => {
        const homeDir = await makeTempHome()
        const sourcePath = join(homeDir, ".pi", "hooks.json")
        await writeFile(sourcePath, "{not valid json")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            await expect(loadUserHooksRegistry({ homeDir })).resolves.toEqual({ files: [] } satisfies HookRegistry)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(sourcePath))
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Unexpected token|Expected property name/))
        } finally {
            warn.mockRestore()
        }
    })

    it("warns and skips a schema-invalid user-level hooks.json", async () => {
        const homeDir = await makeTempHome()
        const sourcePath = join(homeDir, ".pi", "hooks.json")
        await writeFile(
            sourcePath,
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            hooks: [{ type: "command", command: "echo hello" }],
                        },
                    ],
                },
                unexpected: true,
            }),
        )
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            await expect(loadUserHooksRegistry({ homeDir })).resolves.toEqual({ files: [] } satisfies HookRegistry)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(sourcePath))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("unexpected"))
        } finally {
            warn.mockRestore()
        }
    })

    it("warns with the schema validation reason when the user-level hooks file is invalid", async () => {
        const homeDir = await makeTempHome()
        const sourcePath = join(homeDir, ".pi", "hooks.json")
        await writeFile(sourcePath, JSON.stringify({ hooks: {} }))
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            await expect(loadUserHooksRegistry({ homeDir })).resolves.toEqual({ files: [] } satisfies HookRegistry)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(sourcePath))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("must NOT have fewer than 1 properties"))
        } finally {
            warn.mockRestore()
        }
    })

    it("loads other discovered hook files when one project hooks file is schema-invalid", async () => {
        const homeDir = await makeTempHome()
        const workspaceRoot = join(homeDir, "workspace")
        const projectDir = join(workspaceRoot, "apps", "demo")

        await mkdir(join(workspaceRoot, ".pi"), { recursive: true })
        await mkdir(join(workspaceRoot, "apps", ".pi"), { recursive: true })
        await mkdir(join(projectDir, ".pi"), { recursive: true })

        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo global" }] }],
                },
            }),
        )
        await writeFile(
            join(workspaceRoot, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo root" }] }],
                },
            }),
        )
        const invalidProjectHooksPath = join(workspaceRoot, "apps", ".pi", "hooks.json")
        await writeFile(invalidProjectHooksPath, JSON.stringify({ hooks: {} }))
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo project" }] }],
                },
            }),
        )
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            const registry = await loadHooksRegistry({ homeDir, cwd: projectDir })

            expect(registry.files.map((file) => file.sourcePath)).toEqual([
                join(homeDir, ".pi", "hooks.json"),
                join(workspaceRoot, ".pi", "hooks.json"),
                join(projectDir, ".pi", "hooks.json"),
            ])
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(invalidProjectHooksPath))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("must NOT have fewer than 1 properties"))
        } finally {
            warn.mockRestore()
        }
    })

    it("loads other discovered hook files when one project hooks file is malformed", async () => {
        const homeDir = await makeTempHome()
        const workspaceRoot = join(homeDir, "workspace")
        const projectDir = join(workspaceRoot, "apps", "demo")

        await mkdir(join(workspaceRoot, ".pi"), { recursive: true })
        await mkdir(join(workspaceRoot, "apps", ".pi"), { recursive: true })
        await mkdir(join(projectDir, ".pi"), { recursive: true })

        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo global" }] }],
                },
            }),
        )
        const invalidProjectHooksPath = join(workspaceRoot, "apps", ".pi", "hooks.json")
        await writeFile(invalidProjectHooksPath, "{bad json")
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo project" }] }],
                },
            }),
        )
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            const registry = await loadHooksRegistry({ homeDir, cwd: projectDir })

            expect(registry.files.map((file) => file.sourcePath)).toEqual([
                join(homeDir, ".pi", "hooks.json"),
                join(projectDir, ".pi", "hooks.json"),
            ])
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(invalidProjectHooksPath))
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Unexpected token|Expected property name/))
        } finally {
            warn.mockRestore()
        }
    })

    it("runs session_start hooks from the refreshed registry with canonical payload in the session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "session-start-payload.json")
        const skippedOutputPath = join(projectDir, "session-start-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            matcher: "startup",
                            hooks: [{ type: "command", command: createNodeHookCommand(outputPath) }],
                        },
                        {
                            matcher: "reload",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)

            expect(sessionStart).toBeTypeOf("function")

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(getHookRegistry().files.map((file) => file.sourcePath)).toEqual([
                join(canonicalProjectDir, ".pi", "hooks.json"),
            ])

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; reason: string }
                }

                expect(payload).toEqual({
                    event: "session_start",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["startup"] },
                    payload: { type: "session_start", reason: "startup" },
                })
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block session_start on hook completion", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-session-start.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            matcher: "startup",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)

            await expect(
                sessionStart?.(
                    { type: "session_start", reason: "startup" },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toBeUndefined()
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero session_start hook exits without crashing session start", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            matcher: "startup",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.stdout.write('hook-out');process.stderr.write('hook-err');process.exit(7)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)

            await expect(
                sessionStart?.(
                    { type: "session_start", reason: "startup" },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit code 7"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-out"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-err"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching before_agent_start hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "before-agent-start-payload.json")
        const cwdOutputPath = join(projectDir, "before-agent-start-cwd.txt")
        const skippedOutputPath = join(projectDir, "before-agent-start-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    before_agent_start: [
                        {
                            matcher: "hello world",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "goodbye",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const beforeAgentStart = getBeforeAgentStartHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(beforeAgentStart).toBeTypeOf("function")

            await beforeAgentStart?.(
                {
                    type: "before_agent_start",
                    prompt: "hello world",
                    systemPrompt: "You are Pi.",
                    systemPromptOptions: { cwd: canonicalProjectDir },
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: {
                        type: string
                        prompt: string
                        systemPrompt: string
                        systemPromptOptions: { cwd: string }
                    }
                }

                expect(payload).toEqual({
                    event: "before_agent_start",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["hello world"] },
                    payload: {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                })
                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalProjectDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching user_bash hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "user-bash-payload.json")
        const cwdOutputPath = join(projectDir, "user-bash-cwd.txt")
        const skippedOutputPath = join(projectDir, "user-bash-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    user_bash: [
                        {
                            matcher: "npm test",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "pnpm lint",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const userBash = getUserBashHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(userBash).toBeTypeOf("function")

            await userBash?.(
                {
                    type: "user_bash",
                    command: "npm test",
                    excludeFromContext: false,
                    cwd: canonicalProjectDir,
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: {
                        type: string
                        command: string
                        excludeFromContext: boolean
                        cwd: string
                    }
                }

                expect(payload).toEqual({
                    event: "user_bash",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["npm test"] },
                    payload: {
                        type: "user_bash",
                        command: "npm test",
                        excludeFromContext: false,
                        cwd: canonicalProjectDir,
                    },
                })
                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalProjectDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block or mutate before_agent_start handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-before-agent-start.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    before_agent_start: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 5,
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const beforeAgentStart = getBeforeAgentStartHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const event: BeforeAgentStartEvent = {
                type: "before_agent_start",
                prompt: "hello world",
                systemPrompt: "You are Pi.",
                systemPromptOptions: { cwd: canonicalProjectDir },
            }

            expect(beforeAgentStart?.(event, createExtensionContext(canonicalProjectDir))).toBeUndefined()
            expect(event).toEqual({
                type: "before_agent_start",
                prompt: "hello world",
                systemPrompt: "You are Pi.",
                systemPromptOptions: { cwd: canonicalProjectDir },
            })
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block or replace user_bash handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-user-bash.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    user_bash: [
                        {
                            matcher: "npm test",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 5,
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const userBash = getUserBashHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const event: UserBashEvent = {
                type: "user_bash",
                command: "npm test",
                excludeFromContext: false,
                cwd: canonicalProjectDir,
            }

            expect(userBash?.(event, createExtensionContext(canonicalProjectDir))).toBeUndefined()
            expect(event).toEqual({
                type: "user_bash",
                command: "npm test",
                excludeFromContext: false,
                cwd: canonicalProjectDir,
            })
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero before_agent_start hook exits without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    before_agent_start: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.stdout.write('hook-out');process.stderr.write('hook-err');process.exit(7)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const beforeAgentStart = getBeforeAgentStartHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit code 7"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-out"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-err"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports timed out user_bash hooks without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    user_bash: [
                        {
                            matcher: "npm test",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 0.05,
                                    command: `node --input-type=module -e "setTimeout(()=>process.exit(0),200)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const userBash = getUserBashHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                userBash?.(
                    {
                        type: "user_bash",
                        command: "npm test",
                        excludeFromContext: false,
                        cwd: canonicalProjectDir,
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out after 0.05s"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("node --input-type=module"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports before_agent_start hook spawn failures without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    before_agent_start: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.exit(0)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const beforeAgentStart = getBeforeAgentStartHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    createExtensionContext(join(canonicalProjectDir, "missing-cwd")),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command failed before completion"))
                expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENOENT|spawn/i))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching input hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "input-payload.json")
        const cwdOutputPath = join(projectDir, "input-cwd.txt")
        const skippedOutputPath = join(projectDir, "input-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    input: [
                        {
                            matcher: "hello world",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "goodbye",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const input = getInputHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(input).toBeTypeOf("function")

            await input?.(
                {
                    type: "input",
                    text: "hello world",
                    source: "interactive",
                    streamingBehavior: "followUp",
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; text: string; source: string; streamingBehavior: string }
                }

                expect(payload).toEqual({
                    event: "input",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["hello world"] },
                    payload: {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                })
                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalProjectDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block or mutate input handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-input.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    input: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 5,
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const input = getInputHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const event: InputEvent = {
                type: "input",
                text: "hello world",
                source: "interactive",
                streamingBehavior: "followUp",
            }

            expect(input?.(event, createExtensionContext(canonicalProjectDir))).toBeUndefined()
            expect(event).toEqual({
                type: "input",
                text: "hello world",
                source: "interactive",
                streamingBehavior: "followUp",
            })
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("suppresses non-zero input hook warnings without crashing input handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    input: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.stdout.write('hook-out');process.stderr.write('hook-err');process.exit(7)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const input = getInputHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await new Promise((resolve) => setTimeout(resolve, 100))
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("suppresses input hook spawn-failure warnings without crashing input handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    input: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.exit(0)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const input = getInputHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(join(canonicalProjectDir, "missing-cwd")),
                ),
            ).toBeUndefined()
            await new Promise((resolve) => setTimeout(resolve, 100))
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("suppresses timed out input hook warnings without crashing input handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    input: [
                        {
                            matcher: "hello world",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 0.05,
                                    command: `node --input-type=module -e "setTimeout(()=>process.exit(0),200)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const input = getInputHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await new Promise((resolve) => setTimeout(resolve, 150))
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching tool_call hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "tool-call-payload.json")
        const cwdOutputPath = join(projectDir, "tool-call-cwd.txt")
        const skippedOutputPath = join(projectDir, "tool-call-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "read",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "write",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(toolCall).toBeTypeOf("function")

            await toolCall?.(
                {
                    type: "tool_call",
                    toolCallId: "call-1",
                    toolName: "read",
                    input: { path: "README.md" },
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; toolName: string; toolCallId: string; input: { path: string } }
                }

                expect(payload).toEqual({
                    event: "tool_call",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    payload: {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
                })
                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalProjectDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching tool_result hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "tool-result-payload.json")
        const cwdOutputPath = join(projectDir, "tool-result-cwd.txt")
        const skippedOutputPath = join(projectDir, "tool-result-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_result: [
                        {
                            matcher: "read",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "write",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolResult = getToolResultHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(toolResult).toBeTypeOf("function")

            await toolResult?.(
                {
                    type: "tool_result",
                    toolCallId: "call-1",
                    toolName: "read",
                    input: { path: "README.md" },
                    content: [{ type: "text", text: "hello" }],
                    isError: false,
                    details: undefined,
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: {
                        type: string
                        toolName: string
                        toolCallId: string
                        input: { path: string }
                        content: [{ type: string; text: string }]
                        isError: boolean
                    }
                }

                expect(payload).toEqual({
                    event: "tool_result",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    payload: {
                        type: "tool_result",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                        content: [{ type: "text", text: "hello" }],
                        isError: false,
                    },
                })
                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalProjectDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block tool_call on hook completion", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-tool-call.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "read",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 5,
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                toolCall?.(
                    {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero tool_call hook exits without crashing tool execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "read",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.stdout.write('hook-out');process.stderr.write('hook-err');process.exit(7)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                toolCall?.(
                    {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit code 7"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-out"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-err"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block or mutate tool_result handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-tool-result.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_result: [
                        {
                            matcher: "read",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 5,
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolResult = getToolResultHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "call-1",
                toolName: "read",
                input: { path: "README.md" },
                content: [{ type: "text", text: "hello" }],
                isError: false,
                details: undefined,
            }

            expect(toolResult?.(event, createExtensionContext(canonicalProjectDir))).toBeUndefined()
            expect(event).toEqual({
                type: "tool_result",
                toolCallId: "call-1",
                toolName: "read",
                input: { path: "README.md" },
                content: [{ type: "text", text: "hello" }],
                isError: false,
                details: undefined,
            })
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching tool_execution lifecycle hooks with canonical payloads in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const startOutputPath = join(projectDir, "tool-execution-start-payload.json")
        const updateOutputPath = join(projectDir, "tool-execution-update-payload.json")
        const endOutputPath = join(projectDir, "tool-execution-end-payload.json")
        const cwdOutputPath = join(projectDir, "tool-execution-cwd.txt")
        const skippedOutputPath = join(projectDir, "tool-execution-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_execution_start: [
                        {
                            matcher: "read",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(startOutputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                    ],
                    tool_execution_update: [
                        {
                            matcher: "read",
                            hooks: [{ type: "command", command: createNodeHookCommand(updateOutputPath) }],
                        },
                    ],
                    tool_execution_end: [
                        {
                            matcher: "read",
                            hooks: [{ type: "command", command: createNodeHookCommand(endOutputPath) }],
                        },
                        {
                            matcher: "write",
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolExecutionStart = getToolExecutionStartHandler(handlers)
            const toolExecutionUpdate = getToolExecutionUpdateHandler(handlers)
            const toolExecutionEnd = getToolExecutionEndHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(toolExecutionStart).toBeTypeOf("function")
            expect(toolExecutionUpdate).toBeTypeOf("function")
            expect(toolExecutionEnd).toBeTypeOf("function")

            await toolExecutionStart?.(
                {
                    type: "tool_execution_start",
                    toolCallId: "call-1",
                    toolName: "read",
                    args: { path: "README.md" },
                },
                createExtensionContext(canonicalProjectDir),
            )
            await toolExecutionUpdate?.(
                {
                    type: "tool_execution_update",
                    toolCallId: "call-1",
                    toolName: "read",
                    args: { path: "README.md" },
                    partialResult: { chunk: "hello" },
                },
                createExtensionContext(canonicalProjectDir),
            )
            await toolExecutionEnd?.(
                {
                    type: "tool_execution_end",
                    toolCallId: "call-1",
                    toolName: "read",
                    result: { ok: true },
                    isError: false,
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                expect(JSON.parse(await readFile(startOutputPath, "utf8"))).toEqual({
                    event: "tool_execution_start",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    payload: {
                        type: "tool_execution_start",
                        toolCallId: "call-1",
                        toolName: "read",
                        args: { path: "README.md" },
                    },
                })

                expect(JSON.parse(await readFile(updateOutputPath, "utf8"))).toEqual({
                    event: "tool_execution_update",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    payload: {
                        type: "tool_execution_update",
                        toolCallId: "call-1",
                        toolName: "read",
                        args: { path: "README.md" },
                        partialResult: { chunk: "hello" },
                    },
                })

                expect(JSON.parse(await readFile(endOutputPath, "utf8"))).toEqual({
                    event: "tool_execution_end",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    payload: {
                        type: "tool_execution_end",
                        toolCallId: "call-1",
                        toolName: "read",
                        result: { ok: true },
                        isError: false,
                    },
                })

                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalProjectDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports timed out tool_call hooks without crashing tool execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "read",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 0.05,
                                    command: `node --input-type=module -e "setTimeout(()=>process.exit(0),200)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                toolCall?.(
                    {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero tool_result hook exits without crashing tool result handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_result: [
                        {
                            matcher: "read",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.stdout.write('hook-out');process.stderr.write('hook-err');process.exit(7)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolResult = getToolResultHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                toolResult?.(
                    {
                        type: "tool_result",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                        content: [{ type: "text", text: "hello" }],
                        isError: false,
                        details: undefined,
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit code 7"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-out"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-err"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports timed out tool_execution_update hooks without crashing tool lifecycle", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_execution_update: [
                        {
                            matcher: "read",
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 0.05,
                                    command: `node --input-type=module -e "setTimeout(()=>process.exit(0),200)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolExecutionUpdate = getToolExecutionUpdateHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                toolExecutionUpdate?.(
                    {
                        type: "tool_execution_update",
                        toolCallId: "call-1",
                        toolName: "read",
                        args: { path: "README.md" },
                        partialResult: { chunk: "hello" },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("uses the active session cwd from the handler context for discovery and hook execution", async () => {
        const homeDir = await makeTempHome()
        const processDir = join(homeDir, "process-root")
        const sessionDir = join(homeDir, "workspace", "demo")
        const outputPath = join(sessionDir, "ctx-cwd-value.txt")

        await mkdir(join(processDir, ".pi"), { recursive: true })
        await mkdir(join(sessionDir, ".pi"), { recursive: true })
        await writeFile(
            join(processDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: 'node -e "process.exit(0)"' }] }],
                },
            }),
        )
        await writeFile(
            join(sessionDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            matcher: "startup",
                            hooks: [{ type: "command", command: createNodeCwdCommand(outputPath) }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProcessDir = await realpath(processDir)
        const canonicalSessionDir = await realpath(sessionDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProcessDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalSessionDir),
            )

            expect(getHookRegistry().files.map((file) => file.sourcePath)).toEqual([
                join(canonicalSessionDir, ".pi", "hooks.json"),
            ])

            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe(canonicalSessionDir)
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("loads the user-level hooks registry on session start", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            hooks: [{ type: "command", command: "echo from setup" }],
                        },
                    ],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)

            expect(sessionStart).toBeTypeOf("function")

            await sessionStart?.({ type: "session_start", reason: "startup" }, createExtensionContext(canonicalHomeDir))
            const expectedSourcePath = join(canonicalHomeDir, ".pi", "hooks.json")

            expect(getHookRegistry()).toEqual<HookRegistry>({
                files: [
                    {
                        sourcePath: expectedSourcePath,
                        events: [
                            {
                                eventName: "session_start",
                                matcherGroups: [
                                    {
                                        matcher: undefined,
                                        normalizedMatcher: { kind: "all" },
                                        hooks: [
                                            {
                                                enabled: true,
                                                type: "command",
                                                command: "echo from setup",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("loads only the user-level hooks file from loadUserHooksRegistry", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "pi-hooks-root-"))
        tempDirs.push(tempRoot)

        const homeDir = join(tempRoot, "home", "user")
        await mkdir(join(homeDir, ".pi"), { recursive: true })
        await mkdir(join(tempRoot, "home", ".pi"), { recursive: true })

        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo user" }] }],
                },
            }),
        )
        await writeFile(
            join(tempRoot, "home", ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo ancestor" }] }],
                },
            }),
        )

        const registry = await loadUserHooksRegistry({ homeDir })

        expect(registry.files.map((file) => file.sourcePath)).toEqual([join(homeDir, ".pi", "hooks.json")])
    })

    it("loads the global hooks file before project-local hooks files from root to leaf", async () => {
        const homeDir = await makeTempHome()
        const workspaceRoot = join(homeDir, "workspace")
        const projectDir = join(workspaceRoot, "apps", "demo")

        await mkdir(join(workspaceRoot, ".pi"), { recursive: true })
        await mkdir(join(workspaceRoot, "apps", ".pi"), { recursive: true })
        await mkdir(join(projectDir, ".pi"), { recursive: true })

        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo global" }] }],
                },
            }),
        )
        await writeFile(
            join(workspaceRoot, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo root" }] }],
                },
            }),
        )
        await writeFile(
            join(workspaceRoot, "apps", ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo apps" }] }],
                },
            }),
        )
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo project" }] }],
                },
            }),
        )

        const registry = await loadHooksRegistry({ homeDir, cwd: projectDir })

        expect(registry.files.map((file) => file.sourcePath)).toEqual([
            join(homeDir, ".pi", "hooks.json"),
            join(workspaceRoot, ".pi", "hooks.json"),
            join(workspaceRoot, "apps", ".pi", "hooks.json"),
            join(projectDir, ".pi", "hooks.json"),
        ])
    })

    it("loads merged global and project-local hooks on session start", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo global" }] }],
                },
            }),
        )
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo project" }] }],
                },
            }),
        )

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalProjectDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(getHookRegistry().files.map((file) => file.sourcePath)).toEqual([
                join(canonicalHomeDir, ".pi", "hooks.json"),
                join(canonicalProjectDir, ".pi", "hooks.json"),
            ])
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not collapse distinct discovered path strings that resolve to the same file", async () => {
        const realHomeDir = await makeTempHome()
        const aliasRoot = await mkdtemp(join(tmpdir(), "pi-hooks-alias-"))
        tempDirs.push(aliasRoot)
        const aliasHomeDir = join(aliasRoot, "linked-home")

        await symlink(realHomeDir, aliasHomeDir)
        await writeFile(
            join(realHomeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo once" }] }],
                },
            }),
        )

        const registry = await loadHooksRegistry({ homeDir: aliasHomeDir, cwd: realHomeDir })

        expect(registry.files.map((file) => file.sourcePath)).toEqual([
            join(aliasHomeDir, ".pi", "hooks.json"),
            join(realHomeDir, ".pi", "hooks.json"),
        ])
    })

    it("dedupes an exact hooks.json path discovered as both global and project-local", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [{ hooks: [{ type: "command", command: "echo once" }] }],
                },
            }),
        )

        const registry = await loadHooksRegistry({ homeDir, cwd: homeDir })

        expect(registry.files.map((file) => file.sourcePath)).toEqual([join(homeDir, ".pi", "hooks.json")])
    })

    it("exports a setup function", () => {
        expect(setup).toBeTypeOf("function")
    })
})
