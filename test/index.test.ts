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

type InputEventResult =
    | { action: "continue" }
    | { action: "transform"; text: string; images?: unknown[] }
    | { action: "handled" }

type BeforeAgentStartEventResult = {
    message?: {
        customType: string
        content: unknown
        display?: boolean
        details?: unknown
    }
    systemPrompt?: string
}

type ToolCallEventResult = {
    block?: boolean
    reason?: string
}

type RegisteredHandler = (...args: unknown[]) => unknown
type HandlerRegistry = Partial<Record<string, RegisteredHandler | RegisteredHandler[]>>

type ProjectTrustEvent = {
    type: "project_trust"
    cwd: string
}

type ProjectTrustContext = {
    cwd: string
    hasUI: boolean
    mode?: unknown
    ui?: unknown
}

type ProjectTrustEventResult = {
    trusted: "yes" | "no" | "undecided"
    remember?: boolean
}

type ModelSelectEvent = {
    type: "model_select"
    source: "set" | "cycle" | "restore"
    model: {
        id: string
        provider?: string
    }
    previousModel:
        | {
              id: string
              provider?: string
          }
        | undefined
}

type ThinkingLevelSelectEvent = {
    type: "thinking_level_select"
    level: string
    previousLevel: string
}

type ResourcesDiscoverEvent = {
    type: "resources_discover"
    cwd: string
    reason: "startup" | "reload"
}

type SessionInfoChangedEvent = {
    type: "session_info_changed"
    name: string | undefined
}

type SessionBeforeSwitchEvent = {
    type: "session_before_switch"
    reason: "new" | "resume"
    targetSessionFile?: string
}

type SessionBeforeCompactEvent = {
    type: "session_before_compact"
    preparation: unknown
    branchEntries: unknown[]
    customInstructions?: string
    reason: "manual" | "threshold" | "overflow"
    willRetry: boolean
    signal: AbortSignal
}

type SessionCompactEvent = {
    type: "session_compact"
    compactionEntry: unknown
    fromExtension: boolean
    reason: "manual" | "threshold" | "overflow"
    willRetry: boolean
}

type SessionBeforeForkEvent = {
    type: "session_before_fork"
    entryId: string
    position: "before" | "at"
}

type SessionShutdownEvent = {
    type: "session_shutdown"
    reason: "quit" | "reload" | "new" | "resume" | "fork"
    targetSessionFile?: string
}

type SessionBeforeTreeEvent = {
    type: "session_before_tree"
    preparation: unknown
    signal: AbortSignal
}

type SessionTreeEvent = {
    type: "session_tree"
    newLeafId: string | null
    oldLeafId: string | null
    summaryEntry?: unknown
    fromExtension?: boolean
}

type ContextEvent = {
    type: "context"
    messages: unknown[]
}

type BeforeProviderRequestEvent = {
    type: "before_provider_request"
    payload: unknown
}

type BeforeProviderHeadersEvent = {
    type: "before_provider_headers"
    headers: Record<string, string | null>
}

type AfterProviderResponseEvent = {
    type: "after_provider_response"
    status: number
    headers: Record<string, string>
}

type AgentStartEvent = {
    type: "agent_start"
}

type AgentEndEvent = {
    type: "agent_end"
    messages: unknown[]
}

type AgentSettledEvent = {
    type: "agent_settled"
}

type TurnStartEvent = {
    type: "turn_start"
    turnIndex: number
    timestamp: number
}

type TurnEndEvent = {
    type: "turn_end"
    turnIndex: number
    message: unknown
    toolResults: unknown[]
}

type MessageStartEvent = {
    type: "message_start"
    message: unknown
}

type MessageUpdateEvent = {
    type: "message_update"
    message: unknown
    assistantMessageEvent: unknown
}

type MessageEndEvent = {
    type: "message_end"
    message: unknown
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
    const handlers: HandlerRegistry = {}
    const sendMessage = vi.fn()
    const pi = {
        on(event: string, handler: (...args: unknown[]) => unknown) {
            const existing = handlers[event]
            if (existing === undefined) {
                handlers[event] = handler
                return
            }

            if (Array.isArray(existing)) {
                existing.push(handler)
                return
            }

            handlers[event] = [existing, handler]
        },
        sendMessage,
    } as unknown as ExtensionAPI

    return { pi, handlers, sendMessage }
}

function getSessionStartHandler(handlers: HandlerRegistry) {
    return handlers.session_start as ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined
}

function getRuntimeHandler<TEvent>(handlers: HandlerRegistry, eventName: string) {
    return handlers[eventName] as ((event: TEvent, ctx: ExtensionContext) => Promise<void> | undefined) | undefined
}

async function runBeforeAgentStartHandlers(
    handlers: HandlerRegistry,
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
) {
    const registered = handlers.before_agent_start
    if (registered === undefined) {
        return undefined
    }

    const handlerList = Array.isArray(registered) ? registered : [registered]
    const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = []
    let currentSystemPrompt = event.systemPrompt

    for (const handler of handlerList) {
        const result = (await handler(
            {
                ...event,
                systemPrompt: currentSystemPrompt,
            },
            ctx,
        )) as BeforeAgentStartEventResult | undefined

        if (result?.message !== undefined) {
            messages.push(result.message)
        }

        if (result?.systemPrompt !== undefined) {
            currentSystemPrompt = result.systemPrompt
        }
    }

    return {
        messages,
        systemPrompt: currentSystemPrompt,
    }
}

function getBeforeAgentStartHandler(handlers: HandlerRegistry) {
    return async (
        event: BeforeAgentStartEvent,
        ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | undefined> => {
        const aggregate = await runBeforeAgentStartHandlers(handlers, event, ctx)
        if (aggregate === undefined) {
            return undefined
        }

        const message = aggregate.messages.at(-1)
        const systemPrompt = aggregate.systemPrompt === event.systemPrompt ? undefined : aggregate.systemPrompt
        if (message === undefined && systemPrompt === undefined) {
            return undefined
        }

        return {
            message,
            systemPrompt,
        }
    }
}

function getUserBashHandler(handlers: HandlerRegistry) {
    return handlers.user_bash as
        | ((event: UserBashEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getInputHandler(handlers: HandlerRegistry) {
    return handlers.input as
        | ((event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult> | undefined)
        | undefined
}

function getProjectTrustHandler(handlers: HandlerRegistry) {
    return handlers.project_trust as
        | ((event: ProjectTrustEvent, ctx: ProjectTrustContext) => Promise<ProjectTrustEventResult>)
        | undefined
}

function getResourcesDiscoverHandler(handlers: HandlerRegistry) {
    return handlers.resources_discover as
        | ((event: ResourcesDiscoverEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getSessionBeforeSwitchHandler(handlers: HandlerRegistry) {
    return handlers.session_before_switch as
        | ((event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getSessionBeforeCompactHandler(handlers: HandlerRegistry) {
    return handlers.session_before_compact as
        | ((event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getSessionCompactHandler(handlers: HandlerRegistry) {
    return handlers.session_compact as
        | ((event: SessionCompactEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getSessionShutdownHandler(handlers: HandlerRegistry) {
    return handlers.session_shutdown as
        | ((event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getModelSelectHandler(handlers: HandlerRegistry) {
    return handlers.model_select as
        | ((event: ModelSelectEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getThinkingLevelSelectHandler(handlers: HandlerRegistry) {
    return handlers.thinking_level_select as
        | ((event: ThinkingLevelSelectEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolCallHandler(handlers: HandlerRegistry) {
    return handlers.tool_call as
        | ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>)
        | undefined
}

function getToolResultHandler(handlers: HandlerRegistry) {
    return handlers.tool_result as
        | ((event: ToolResultEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolExecutionStartHandler(handlers: HandlerRegistry) {
    return handlers.tool_execution_start as
        | ((event: ToolExecutionStartEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolExecutionUpdateHandler(handlers: HandlerRegistry) {
    return handlers.tool_execution_update as
        | ((event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => Promise<void> | undefined)
        | undefined
}

function getToolExecutionEndHandler(handlers: HandlerRegistry) {
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

function createStdoutHookCommand(stdout: string) {
    return `node --input-type=module -e "process.stdout.write(process.argv[1]);" ${JSON.stringify(stdout)}`
}

function createLatestInputTransformHookCommand(suffix: string) {
    return `node --input-type=module -e "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const payload=JSON.parse(input);process.stdout.write(JSON.stringify({version:1,event:'input',output:{action:'transform',text:String(payload.payload.text)+process.argv[1]}}));});" ${JSON.stringify(suffix)}`
}

function createLatestBeforeAgentStartHookCommand(options: {
    messageType: string
    messageContent: string
    systemPromptSuffix?: string
}) {
    return `node --input-type=module -e "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const payload=JSON.parse(input);const output={message:{customType:process.argv[1],content:process.argv[2]}};if(process.argv[3])output.systemPrompt=String(payload.payload.systemPrompt)+process.argv[3];process.stdout.write(JSON.stringify({version:1,event:'before_agent_start',output}));});" ${JSON.stringify(options.messageType)} ${JSON.stringify(options.messageContent)} ${JSON.stringify(options.systemPromptSuffix ?? "")}`
}

function createLatestToolCallInputHookCommand(suffix: string) {
    return `node --input-type=module -e "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const payload=JSON.parse(input);process.stdout.write(JSON.stringify({version:1,event:'tool_call',output:{input:{step:String(payload.payload.input.step)+process.argv[1]}}}));});" ${JSON.stringify(suffix)}`
}

function createLatestToolCallBlockHookCommand(reason: string) {
    return `node --input-type=module -e "process.stdout.write(JSON.stringify({version:1,event:'tool_call',output:{block:{reason:process.argv[1]}}}));" ${JSON.stringify(reason)}`
}

function createLongRunningHookCommand(options: { startedPath: string; resultPath: string; completeAfterMs: number }) {
    return `exec node --input-type=module -e "import('node:fs').then(fs=>{fs.writeFileSync(process.argv[1],'started');process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],'terminated');process.exit(0);});setTimeout(()=>{fs.writeFileSync(process.argv[2],'completed');process.exit(0);},Number(process.argv[3]));});" ${JSON.stringify(options.startedPath)} ${JSON.stringify(options.resultPath)} ${JSON.stringify(String(options.completeAfterMs))}`
}

function createExtensionContext(cwd: string, options: { signal?: AbortSignal } = {}) {
    return { cwd, signal: options.signal } as ExtensionContext
}

function createProjectTrustContext(cwd: string, options: { hasUI?: boolean } = {}) {
    return { cwd, hasUI: options.hasUI ?? false, mode: "test", ui: {} } as ProjectTrustContext
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
                    version: 1,
                    event: "session_start",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["startup"] },
                    cwd: canonicalProjectDir,
                    payload: { type: "session_start", reason: "startup" },
                })
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching project_trust hooks from the user registry and defers the trust decision", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "project-trust-payload.json")
        const cwdOutputPath = join(projectDir, "project-trust-cwd.txt")
        const skippedOutputPath = join(projectDir, "project-trust-skipped.json")
        const projectLocalOutputPath = join(projectDir, "project-trust-project-local.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })

        const canonicalHomeDir = await realpath(homeDir)
        const canonicalProjectDir = await realpath(projectDir)

        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    project_trust: [
                        {
                            matcher: canonicalProjectDir,
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: join(canonicalProjectDir, "other"),
                            hooks: [{ type: "command", command: createNodeHookCommand(skippedOutputPath) }],
                        },
                    ],
                },
            }),
        )
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    project_trust: [
                        {
                            matcher: canonicalProjectDir,
                            hooks: [{ type: "command", command: createNodeHookCommand(projectLocalOutputPath) }],
                        },
                    ],
                },
            }),
        )
        const previousHome = process.env.HOME
        const previousCwd = process.cwd()
        process.env.HOME = canonicalHomeDir
        process.chdir(canonicalHomeDir)

        try {
            const registry = await loadUserHooksRegistry({ homeDir: canonicalHomeDir })
            expect(registry.files).toHaveLength(1)
            expect(registry.files[0]?.events[0]?.eventName).toBe("project_trust")
            expect(registry.files[0]?.events[0]?.matcherGroups[0]?.normalizedMatcher).toEqual({
                kind: "exact",
                values: [canonicalProjectDir],
            })

            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const projectTrust = getProjectTrustHandler(handlers)

            expect(projectTrust).toBeTypeOf("function")

            await expect(
                projectTrust?.(
                    {
                        type: "project_trust",
                        cwd: canonicalProjectDir,
                    },
                    createProjectTrustContext(canonicalHomeDir),
                ),
            ).resolves.toEqual({ trusted: "undecided" })

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; cwd: string }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "project_trust",
                    sourcePath: join(canonicalHomeDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: [canonicalProjectDir] },
                    cwd: canonicalHomeDir,
                    payload: {
                        type: "project_trust",
                        cwd: canonicalProjectDir,
                    },
                })
                await expect(readFile(cwdOutputPath, "utf8")).resolves.toBe(canonicalHomeDir)
            })
            await expect(readFile(skippedOutputPath, "utf8")).rejects.toThrow()
            await expect(readFile(projectLocalOutputPath, "utf8")).rejects.toThrow()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs matching model_select hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "model-select-payload.json")
        const cwdOutputPath = join(projectDir, "model-select-cwd.txt")
        const skippedOutputPath = join(projectDir, "model-select-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    model_select: [
                        {
                            matcher: "cycle",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "restore",
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
            const modelSelect = getModelSelectHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(modelSelect).toBeTypeOf("function")

            await modelSelect?.(
                {
                    type: "model_select",
                    source: "cycle",
                    model: {
                        id: "gpt-5",
                        provider: "openai",
                    },
                    previousModel: {
                        id: "gpt-4.1",
                        provider: "openai",
                    },
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
                        source: string
                        model: { id: string; provider?: string }
                        previousModel: { id: string; provider?: string } | undefined
                    }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "model_select",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["cycle"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "model_select",
                        source: "cycle",
                        model: {
                            id: "gpt-5",
                            provider: "openai",
                        },
                        previousModel: {
                            id: "gpt-4.1",
                            provider: "openai",
                        },
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

    it("runs matching thinking_level_select hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "thinking-level-select-payload.json")
        const cwdOutputPath = join(projectDir, "thinking-level-select-cwd.txt")
        const skippedOutputPath = join(projectDir, "thinking-level-select-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    thinking_level_select: [
                        {
                            matcher: "high",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "minimal",
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
            const thinkingLevelSelect = getThinkingLevelSelectHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(thinkingLevelSelect).toBeTypeOf("function")

            await thinkingLevelSelect?.(
                {
                    type: "thinking_level_select",
                    level: "high",
                    previousLevel: "minimal",
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
                        level: string
                        previousLevel: string
                    }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "thinking_level_select",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["high"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "thinking_level_select",
                        level: "high",
                        previousLevel: "minimal",
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

    it("runs match-all-only session and provider hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })

        const cases = [
            {
                eventName: "session_info_changed",
                event: { type: "session_info_changed", name: "renamed-session" } satisfies SessionInfoChangedEvent,
                payloadPath: join(projectDir, "session-info-changed-payload.json"),
                cwdPath: join(projectDir, "session-info-changed-cwd.txt"),
            },
            {
                eventName: "session_before_fork",
                event: {
                    type: "session_before_fork",
                    entryId: "entry-42",
                    position: "before",
                } satisfies SessionBeforeForkEvent,
                payloadPath: join(projectDir, "session-before-fork-payload.json"),
                cwdPath: join(projectDir, "session-before-fork-cwd.txt"),
            },
            {
                eventName: "session_before_tree",
                event: {
                    type: "session_before_tree",
                    preparation: { targetId: "leaf-2", oldLeafId: "leaf-1" },
                    signal: new AbortController().signal,
                } satisfies SessionBeforeTreeEvent,
                payloadPath: join(projectDir, "session-before-tree-payload.json"),
                cwdPath: join(projectDir, "session-before-tree-cwd.txt"),
            },
            {
                eventName: "session_tree",
                event: {
                    type: "session_tree",
                    newLeafId: "leaf-2",
                    oldLeafId: "leaf-1",
                    summaryEntry: { id: "summary-1" },
                    fromExtension: false,
                } satisfies SessionTreeEvent,
                payloadPath: join(projectDir, "session-tree-payload.json"),
                cwdPath: join(projectDir, "session-tree-cwd.txt"),
            },
            {
                eventName: "context",
                event: {
                    type: "context",
                    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
                } satisfies ContextEvent,
                payloadPath: join(projectDir, "context-payload.json"),
                cwdPath: join(projectDir, "context-cwd.txt"),
            },
            {
                eventName: "before_provider_request",
                event: {
                    type: "before_provider_request",
                    payload: { model: "gpt-5", messages: [{ role: "user", content: "hello" }] },
                } satisfies BeforeProviderRequestEvent,
                payloadPath: join(projectDir, "before-provider-request-payload.json"),
                cwdPath: join(projectDir, "before-provider-request-cwd.txt"),
            },
            {
                eventName: "before_provider_headers",
                event: {
                    type: "before_provider_headers",
                    headers: { authorization: "Bearer token", "x-trace-id": null },
                } satisfies BeforeProviderHeadersEvent,
                payloadPath: join(projectDir, "before-provider-headers-payload.json"),
                cwdPath: join(projectDir, "before-provider-headers-cwd.txt"),
            },
            {
                eventName: "after_provider_response",
                event: {
                    type: "after_provider_response",
                    status: 200,
                    headers: { "content-type": "application/json" },
                } satisfies AfterProviderResponseEvent,
                payloadPath: join(projectDir, "after-provider-response-payload.json"),
                cwdPath: join(projectDir, "after-provider-response-cwd.txt"),
            },
        ] as const

        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: Object.fromEntries(
                    cases.map(({ eventName, payloadPath, cwdPath }) => [
                        eventName,
                        [
                            {
                                hooks: [
                                    { type: "command", command: createNodeHookCommand(payloadPath) },
                                    { type: "command", command: createNodeCwdCommand(cwdPath) },
                                ],
                            },
                        ],
                    ]),
                ),
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

            await getSessionStartHandler(handlers)?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            for (const testCase of cases) {
                const handler = getRuntimeHandler<typeof testCase.event>(handlers, testCase.eventName)
                expect(handler).toBeTypeOf("function")
                await handler?.(testCase.event, createExtensionContext(canonicalProjectDir))
            }

            await vi.waitFor(async () => {
                for (const testCase of cases) {
                    const payload = JSON.parse(await readFile(testCase.payloadPath, "utf8")) as {
                        event: string
                        sourcePath: string
                        matcher: unknown
                        payload: unknown
                    }

                    expect(payload).toEqual({
                        version: 1,
                        event: testCase.eventName,
                        sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                        matcher: { kind: "all" },
                        cwd: canonicalProjectDir,
                        payload: JSON.parse(JSON.stringify(testCase.event)),
                    })
                    await expect(readFile(testCase.cwdPath, "utf8")).resolves.toBe(canonicalProjectDir)
                }
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("runs match-all-only agent and message hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })

        const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
        }
        const cases = [
            {
                eventName: "agent_start",
                event: { type: "agent_start" } satisfies AgentStartEvent,
                payloadPath: join(projectDir, "agent-start-payload.json"),
                cwdPath: join(projectDir, "agent-start-cwd.txt"),
            },
            {
                eventName: "agent_end",
                event: { type: "agent_end", messages: [assistantMessage] } satisfies AgentEndEvent,
                payloadPath: join(projectDir, "agent-end-payload.json"),
                cwdPath: join(projectDir, "agent-end-cwd.txt"),
            },
            {
                eventName: "agent_settled",
                event: { type: "agent_settled" } satisfies AgentSettledEvent,
                payloadPath: join(projectDir, "agent-settled-payload.json"),
                cwdPath: join(projectDir, "agent-settled-cwd.txt"),
            },
            {
                eventName: "turn_start",
                event: { type: "turn_start", turnIndex: 2, timestamp: 1234567890 } satisfies TurnStartEvent,
                payloadPath: join(projectDir, "turn-start-payload.json"),
                cwdPath: join(projectDir, "turn-start-cwd.txt"),
            },
            {
                eventName: "turn_end",
                event: {
                    type: "turn_end",
                    turnIndex: 2,
                    message: assistantMessage,
                    toolResults: [{ toolName: "read", content: [{ type: "text", text: "ok" }] }],
                } satisfies TurnEndEvent,
                payloadPath: join(projectDir, "turn-end-payload.json"),
                cwdPath: join(projectDir, "turn-end-cwd.txt"),
            },
            {
                eventName: "message_start",
                event: { type: "message_start", message: assistantMessage } satisfies MessageStartEvent,
                payloadPath: join(projectDir, "message-start-payload.json"),
                cwdPath: join(projectDir, "message-start-cwd.txt"),
            },
            {
                eventName: "message_update",
                event: {
                    type: "message_update",
                    message: assistantMessage,
                    assistantMessageEvent: { type: "text_delta", text: "more" },
                } satisfies MessageUpdateEvent,
                payloadPath: join(projectDir, "message-update-payload.json"),
                cwdPath: join(projectDir, "message-update-cwd.txt"),
            },
            {
                eventName: "message_end",
                event: { type: "message_end", message: assistantMessage } satisfies MessageEndEvent,
                payloadPath: join(projectDir, "message-end-payload.json"),
                cwdPath: join(projectDir, "message-end-cwd.txt"),
            },
        ] as const

        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: Object.fromEntries(
                    cases.map(({ eventName, payloadPath, cwdPath }) => [
                        eventName,
                        [
                            {
                                hooks: [
                                    { type: "command", command: createNodeHookCommand(payloadPath) },
                                    { type: "command", command: createNodeCwdCommand(cwdPath) },
                                ],
                            },
                        ],
                    ]),
                ),
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

            await getSessionStartHandler(handlers)?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            for (const testCase of cases) {
                const handler = getRuntimeHandler<typeof testCase.event>(handlers, testCase.eventName)
                expect(handler).toBeTypeOf("function")
                await handler?.(testCase.event, createExtensionContext(canonicalProjectDir))
            }

            await vi.waitFor(async () => {
                for (const testCase of cases) {
                    const payload = JSON.parse(await readFile(testCase.payloadPath, "utf8")) as {
                        event: string
                        sourcePath: string
                        matcher: unknown
                        payload: unknown
                    }

                    expect(payload).toEqual({
                        version: 1,
                        event: testCase.eventName,
                        sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                        matcher: { kind: "all" },
                        cwd: canonicalProjectDir,
                        payload: JSON.parse(JSON.stringify(testCase.event)),
                    })
                    await expect(readFile(testCase.cwdPath, "utf8")).resolves.toBe(canonicalProjectDir)
                }
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("warns and ignores configured matchers for match-all-only events while still running hooks", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "session-info-changed-ignored-matcher.json")
        const invalidRegexOutputPath = join(projectDir, "session-info-changed-invalid-regex.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_info_changed: [
                        {
                            matcher: "named-session-only",
                            hooks: [{ type: "command", command: createNodeHookCommand(outputPath) }],
                        },
                        {
                            matcher: "[",
                            hooks: [{ type: "command", command: createNodeHookCommand(invalidRegexOutputPath) }],
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
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            await getSessionStartHandler(handlers)?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring matcher in hooks.json"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("session_info_changed"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("named-session-only"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("["))
            expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Invalid matcher"))

            await getRuntimeHandler<SessionInfoChangedEvent>(handlers, "session_info_changed")?.(
                { type: "session_info_changed", name: "different-name" },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; name: string | undefined }
                }
                const invalidRegexPayload = JSON.parse(await readFile(invalidRegexOutputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; name: string | undefined }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "session_info_changed",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "all" },
                    cwd: canonicalProjectDir,
                    payload: { type: "session_info_changed", name: "different-name" },
                })
                expect(invalidRegexPayload).toEqual({
                    version: 1,
                    event: "session_info_changed",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "all" },
                    cwd: canonicalProjectDir,
                    payload: { type: "session_info_changed", name: "different-name" },
                })
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("does not block or mutate match-all-only observe-only handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-session-before-fork.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_fork: [
                        {
                            hooks: [
                                {
                                    type: "command",
                                    timeout: 5,
                                    command: `node --input-type=module -e "import('node:fs').then(fs=>{setTimeout(()=>fs.writeFileSync(process.argv[1],'done'),150);});" ${JSON.stringify(outputPath)}`,
                                },
                            ],
                        },
                    ],
                    context: [{ hooks: [{ type: "command", command: "echo context >/dev/null" }] }],
                    before_provider_request: [{ hooks: [{ type: "command", command: "echo request >/dev/null" }] }],
                    before_provider_headers: [{ hooks: [{ type: "command", command: "echo headers >/dev/null" }] }],
                    message_end: [{ hooks: [{ type: "command", command: "echo message >/dev/null" }] }],
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

            await getSessionStartHandler(handlers)?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const sessionBeforeForkEvent: SessionBeforeForkEvent = {
                type: "session_before_fork",
                entryId: "entry-9",
                position: "at",
            }
            const contextEvent: ContextEvent = {
                type: "context",
                messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            }
            const beforeProviderRequestEvent: BeforeProviderRequestEvent = {
                type: "before_provider_request",
                payload: { model: "gpt-5" },
            }
            const beforeProviderHeadersEvent: BeforeProviderHeadersEvent = {
                type: "before_provider_headers",
                headers: { authorization: "Bearer token" },
            }
            const messageEndEvent: MessageEndEvent = {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "done" }] },
            }

            expect(
                getRuntimeHandler<SessionBeforeForkEvent>(handlers, "session_before_fork")?.(
                    sessionBeforeForkEvent,
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            expect(
                getRuntimeHandler<ContextEvent>(handlers, "context")?.(
                    contextEvent,
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            expect(
                getRuntimeHandler<BeforeProviderRequestEvent>(handlers, "before_provider_request")?.(
                    beforeProviderRequestEvent,
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            expect(
                getRuntimeHandler<BeforeProviderHeadersEvent>(handlers, "before_provider_headers")?.(
                    beforeProviderHeadersEvent,
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            expect(
                getRuntimeHandler<MessageEndEvent>(handlers, "message_end")?.(
                    messageEndEvent,
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()

            expect(sessionBeforeForkEvent).toEqual({ type: "session_before_fork", entryId: "entry-9", position: "at" })
            expect(contextEvent).toEqual({
                type: "context",
                messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            })
            expect(beforeProviderRequestEvent).toEqual({ type: "before_provider_request", payload: { model: "gpt-5" } })
            expect(beforeProviderHeadersEvent).toEqual({
                type: "before_provider_headers",
                headers: { authorization: "Bearer token" },
            })
            expect(messageEndEvent).toEqual({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "done" }] },
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

    it("runs matching resources_discover hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "resources-discover-payload.json")
        const cwdOutputPath = join(projectDir, "resources-discover-cwd.txt")
        const skippedOutputPath = join(projectDir, "resources-discover-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    resources_discover: [
                        {
                            matcher: "startup",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
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
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const resourcesDiscover = getResourcesDiscoverHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(resourcesDiscover).toBeTypeOf("function")

            await resourcesDiscover?.(
                {
                    type: "resources_discover",
                    cwd: canonicalProjectDir,
                    reason: "startup",
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; cwd: string; reason: string }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "resources_discover",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["startup"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "resources_discover",
                        cwd: canonicalProjectDir,
                        reason: "startup",
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

    it("runs matching session_before_switch hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "session-before-switch-payload.json")
        const cwdOutputPath = join(projectDir, "session-before-switch-cwd.txt")
        const skippedOutputPath = join(projectDir, "session-before-switch-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_switch: [
                        {
                            matcher: "resume",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "new",
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
            const sessionBeforeSwitch = getSessionBeforeSwitchHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(sessionBeforeSwitch).toBeTypeOf("function")

            await sessionBeforeSwitch?.(
                {
                    type: "session_before_switch",
                    reason: "resume",
                    targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "resume.json"),
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; reason: string; targetSessionFile?: string }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "session_before_switch",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["resume"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "session_before_switch",
                        reason: "resume",
                        targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "resume.json"),
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

    it("runs matching session_before_compact hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "session-before-compact-payload.json")
        const cwdOutputPath = join(projectDir, "session-before-compact-cwd.txt")
        const skippedOutputPath = join(projectDir, "session-before-compact-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_compact: [
                        {
                            matcher: "threshold",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "manual",
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
            const sessionBeforeCompact = getSessionBeforeCompactHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(sessionBeforeCompact).toBeTypeOf("function")

            await sessionBeforeCompact?.(
                {
                    type: "session_before_compact",
                    preparation: { tokenEstimate: 42 },
                    branchEntries: [{ id: "entry-1" }],
                    customInstructions: "Summarize briefly",
                    reason: "threshold",
                    willRetry: false,
                    signal: new AbortController().signal,
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
                        preparation: { tokenEstimate: number }
                        branchEntries: Array<{ id: string }>
                        customInstructions?: string
                        reason: string
                        willRetry: boolean
                        signal: object
                    }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "session_before_compact",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["threshold"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "session_before_compact",
                        preparation: { tokenEstimate: 42 },
                        branchEntries: [{ id: "entry-1" }],
                        customInstructions: "Summarize briefly",
                        reason: "threshold",
                        willRetry: false,
                        signal: {},
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

    it("runs matching session_compact hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "session-compact-payload.json")
        const cwdOutputPath = join(projectDir, "session-compact-cwd.txt")
        const skippedOutputPath = join(projectDir, "session-compact-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_compact: [
                        {
                            matcher: "overflow",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "manual",
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
            const sessionCompact = getSessionCompactHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(sessionCompact).toBeTypeOf("function")

            await sessionCompact?.(
                {
                    type: "session_compact",
                    compactionEntry: { id: "compact-1" },
                    fromExtension: false,
                    reason: "overflow",
                    willRetry: true,
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
                        compactionEntry: { id: string }
                        fromExtension: boolean
                        reason: string
                        willRetry: boolean
                    }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "session_compact",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["overflow"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "session_compact",
                        compactionEntry: { id: "compact-1" },
                        fromExtension: false,
                        reason: "overflow",
                        willRetry: true,
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

    it("runs matching session_shutdown hooks with canonical payload in the active session cwd", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "session-shutdown-payload.json")
        const cwdOutputPath = join(projectDir, "session-shutdown-cwd.txt")
        const skippedOutputPath = join(projectDir, "session-shutdown-skipped.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_shutdown: [
                        {
                            matcher: "resume",
                            hooks: [
                                { type: "command", command: createNodeHookCommand(outputPath) },
                                { type: "command", command: createNodeCwdCommand(cwdOutputPath) },
                            ],
                        },
                        {
                            matcher: "quit",
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
            const sessionShutdown = getSessionShutdownHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(sessionShutdown).toBeTypeOf("function")

            await sessionShutdown?.(
                {
                    type: "session_shutdown",
                    reason: "resume",
                    targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "next.json"),
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
                    event: string
                    sourcePath: string
                    matcher: unknown
                    payload: { type: string; reason: string; targetSessionFile?: string }
                }

                expect(payload).toEqual({
                    version: 1,
                    event: "session_shutdown",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["resume"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "session_shutdown",
                        reason: "resume",
                        targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "next.json"),
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

    it("does not block or cancel session_before_switch handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-session-before-switch.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_switch: [
                        {
                            matcher: "resume",
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
            const sessionBeforeSwitch = getSessionBeforeSwitchHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const event: SessionBeforeSwitchEvent = {
                type: "session_before_switch",
                reason: "resume",
                targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "resume.json"),
            }

            expect(sessionBeforeSwitch?.(event, createExtensionContext(canonicalProjectDir))).toBeUndefined()
            expect(event).toEqual({
                type: "session_before_switch",
                reason: "resume",
                targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "resume.json"),
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

    it("does not block or customize session_before_compact handling", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const outputPath = join(projectDir, "slow-session-before-compact.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_compact: [
                        {
                            matcher: "manual",
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
            const sessionBeforeCompact = getSessionBeforeCompactHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const event: SessionBeforeCompactEvent = {
                type: "session_before_compact",
                preparation: { tokenEstimate: 99 },
                branchEntries: [{ id: "entry-1" }],
                customInstructions: "Keep this",
                reason: "manual",
                willRetry: false,
                signal: new AbortController().signal,
            }

            expect(sessionBeforeCompact?.(event, createExtensionContext(canonicalProjectDir))).toBeUndefined()
            expect(event.preparation).toEqual({ tokenEstimate: 99 })
            expect(event.branchEntries).toEqual([{ id: "entry-1" }])
            expect(event.customInstructions).toBe("Keep this")
            expect(event.reason).toBe("manual")
            expect(event.willRetry).toBe(false)
            await expect(readFile(outputPath, "utf8")).rejects.toThrow()
            await vi.waitFor(async () => {
                await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("cancels in-flight hooks when the exposed event abort signal aborts", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const startedPath = join(projectDir, "abort-hook-started.txt")
        const resultPath = join(projectDir, "abort-hook-result.txt")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_compact: [
                        {
                            matcher: "threshold",
                            hooks: [
                                {
                                    type: "command",
                                    command: createLongRunningHookCommand({
                                        startedPath,
                                        resultPath,
                                        completeAfterMs: 1000,
                                    }),
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
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const sessionBeforeCompact = getSessionBeforeCompactHandler(handlers)
            const controller = new AbortController()

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(sessionBeforeCompact).toBeTypeOf("function")

            expect(
                sessionBeforeCompact?.(
                    {
                        type: "session_before_compact",
                        preparation: { tokenEstimate: 42 },
                        branchEntries: [{ id: "entry-1" }],
                        reason: "threshold",
                        willRetry: false,
                        signal: controller.signal,
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()

            await vi.waitFor(async () => {
                await expect(readFile(startedPath, "utf8")).resolves.toBe("started")
            })

            controller.abort()

            await vi.waitFor(async () => {
                await expect(readFile(resultPath, "utf8")).resolves.toBe("terminated")
            })
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command aborted"))
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("cancels in-flight hooks when the extension context abort signal aborts", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const startedPath = join(projectDir, "ctx-abort-hook-started.txt")
        const resultPath = join(projectDir, "ctx-abort-hook-result.txt")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

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
                                    command: createLongRunningHookCommand({
                                        startedPath,
                                        resultPath,
                                        completeAfterMs: 1000,
                                    }),
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
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)
            const controller = new AbortController()

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(toolCall).toBeTypeOf("function")

            const toolCallPromise = toolCall?.(
                {
                    type: "tool_call",
                    toolCallId: "call-1",
                    toolName: "read",
                    input: { path: "README.md" },
                },
                createExtensionContext(canonicalProjectDir, { signal: controller.signal }),
            )

            await vi.waitFor(async () => {
                await expect(readFile(startedPath, "utf8")).resolves.toBe("started")
            })

            controller.abort()

            await vi.waitFor(async () => {
                await expect(readFile(resultPath, "utf8")).resolves.toBe("terminated")
            })
            await expect(toolCallPromise).resolves.toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command aborted"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("cancels in-flight hooks and clears session state during replacement shutdown", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const startedPath = join(projectDir, "shutdown-hook-started.txt")
        const resultPath = join(projectDir, "shutdown-hook-result.txt")

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
                                    command: createLongRunningHookCommand({
                                        startedPath,
                                        resultPath,
                                        completeAfterMs: 1000,
                                    }),
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
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)
            const sessionShutdown = getSessionShutdownHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(toolCall).toBeTypeOf("function")
            expect(sessionShutdown).toBeTypeOf("function")

            const toolCallPromise = toolCall?.(
                {
                    type: "tool_call",
                    toolCallId: "call-1",
                    toolName: "read",
                    input: { path: "README.md" },
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                await expect(readFile(startedPath, "utf8")).resolves.toBe("started")
            })

            expect(
                sessionShutdown?.(
                    {
                        type: "session_shutdown",
                        reason: "resume",
                        targetSessionFile: join(canonicalProjectDir, ".pi", "sessions", "resume.json"),
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()

            expect(getHookRegistry()).toEqual({ files: [] })
            await vi.waitFor(async () => {
                await expect(readFile(resultPath, "utf8")).resolves.toBe("terminated")
            })
            await expect(toolCallPromise).resolves.toBeUndefined()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("cancels timed out hook processes before they can complete", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const startedPath = join(projectDir, "timeout-hook-started.txt")
        const resultPath = join(projectDir, "timeout-hook-result.txt")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

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
                                    command: createLongRunningHookCommand({
                                        startedPath,
                                        resultPath,
                                        completeAfterMs: 1000,
                                    }),
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

            const toolCallPromise = toolCall?.(
                {
                    type: "tool_call",
                    toolCallId: "call-1",
                    toolName: "read",
                    input: { path: "README.md" },
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                await expect(readFile(startedPath, "utf8")).resolves.toBe("started")
            })
            await vi.waitFor(async () => {
                await expect(readFile(resultPath, "utf8")).resolves.toBe("terminated")
            })
            await expect(toolCallPromise).resolves.toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out after 0.05s"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("cancels in-flight hooks during ordinary quit shutdown", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const startedPath = join(projectDir, "quit-shutdown-hook-started.txt")
        const resultPath = join(projectDir, "quit-shutdown-hook-result.txt")

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
                                    command: createLongRunningHookCommand({
                                        startedPath,
                                        resultPath,
                                        completeAfterMs: 1000,
                                    }),
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
        process.chdir(canonicalHomeDir)

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const toolCall = getToolCallHandler(handlers)
            const sessionShutdown = getSessionShutdownHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            const toolCallPromise = toolCall?.(
                {
                    type: "tool_call",
                    toolCallId: "call-1",
                    toolName: "read",
                    input: { path: "README.md" },
                },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(async () => {
                await expect(readFile(startedPath, "utf8")).resolves.toBe("started")
            })

            expect(
                sessionShutdown?.(
                    {
                        type: "session_shutdown",
                        reason: "quit",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()

            expect(getHookRegistry()).toEqual({ files: [] })
            await vi.waitFor(async () => {
                await expect(readFile(resultPath, "utf8")).resolves.toBe("terminated")
            })
            await expect(toolCallPromise).resolves.toBeUndefined()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero session_shutdown hook exits without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_shutdown: [
                        {
                            matcher: "quit",
                            hooks: [
                                {
                                    type: "command",
                                    command: `node --input-type=module -e "process.stdout.write('hook-out');process.stderr.write('hook-err');process.exit(9)"`,
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
            const sessionShutdown = getSessionShutdownHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                sessionShutdown?.(
                    {
                        type: "session_shutdown",
                        reason: "quit",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit code 9"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-out"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("hook-err"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports timed out session_compact hooks without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_compact: [
                        {
                            matcher: "manual",
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
            const sessionCompact = getSessionCompactHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                sessionCompact?.(
                    {
                        type: "session_compact",
                        compactionEntry: { id: "compact-1" },
                        fromExtension: false,
                        reason: "manual",
                        willRetry: false,
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

    it("reports session_compact stdin EPIPE failures without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_compact: [
                        {
                            matcher: "manual",
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
            const sessionCompact = getSessionCompactHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                sessionCompact?.(
                    {
                        type: "session_compact",
                        compactionEntry: { body: "x".repeat(2_000_000) },
                        fromExtension: false,
                        reason: "manual",
                        willRetry: false,
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).toBeUndefined()
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command failed before completion"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("write EPIPE"))
            })
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports session_before_switch hook spawn failures without crashing handler execution", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_before_switch: [
                        {
                            matcher: "new",
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
            const sessionBeforeSwitch = getSessionBeforeSwitchHandler(handlers)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            expect(
                sessionBeforeSwitch?.(
                    {
                        type: "session_before_switch",
                        reason: "new",
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

    it("warns and ignores malformed, unknown, and event-unsupported stdout for observe-only session_info_changed hooks", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_info_changed: [
                        {
                            hooks: [
                                { type: "command", command: createStdoutHookCommand("{not valid json") },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "session_info_changed",
                                            output: {},
                                            extra: true,
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "session_info_changed",
                                            output: { systemPrompt: "Override" },
                                        }),
                                    ),
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
        process.chdir(canonicalHomeDir)

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const sessionInfoChanged = getRuntimeHandler<SessionInfoChangedEvent>(handlers, "session_info_changed")

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            await sessionInfoChanged?.(
                { type: "session_info_changed", name: "renamed-session" },
                createExtensionContext(canonicalProjectDir),
            )

            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(
                    expect.stringContaining("Ignoring invalid hook stdout for session_info_changed"),
                )
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown property extra"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown property systemPrompt"))
                expect(warn).not.toHaveBeenCalledWith(
                    expect.stringContaining(
                        "Ignoring hook stdout for session_info_changed: semantic output is not supported yet",
                    ),
                )
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
                    version: 1,
                    event: "before_agent_start",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["hello world"] },
                    cwd: canonicalProjectDir,
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

    it("returns before_agent_start message injection and system-prompt replacement from valid semantic stdout", async () => {
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
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "before_agent_start",
                                            output: {
                                                message: {
                                                    customType: "pi-hooks.test",
                                                    content: "Injected context",
                                                    display: true,
                                                },
                                                systemPrompt: "You are Hook Pi.",
                                            },
                                        }),
                                    ),
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

            await expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({
                message: {
                    customType: "pi-hooks.test",
                    content: "Injected context",
                    display: true,
                },
                systemPrompt: "You are Hook Pi.",
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("composes before_agent_start messages in configured order over the latest system prompt", async () => {
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
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "before_agent_start",
                                            output: {
                                                message: {
                                                    customType: "pi-hooks.first",
                                                    content: "First message",
                                                },
                                                systemPrompt: "You are Pi. -> first",
                                            },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createLatestBeforeAgentStartHookCommand({
                                        messageType: "pi-hooks.second",
                                        messageContent: "Second message",
                                        systemPromptSuffix: " -> second",
                                    }),
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
            const { pi, handlers, sendMessage } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const beforeAgentStart = getBeforeAgentStartHandler(handlers)
            const ctx = createExtensionContext(canonicalProjectDir)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            await expect(
                runBeforeAgentStartHandlers(
                    handlers,
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    ctx,
                ),
            ).resolves.toEqual({
                messages: [
                    {
                        customType: "pi-hooks.first",
                        content: "First message",
                    },
                    {
                        customType: "pi-hooks.second",
                        content: "Second message",
                    },
                ],
                systemPrompt: "You are Pi. -> first -> second",
            })
            await expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    ctx,
                ),
            ).resolves.toEqual({
                message: {
                    customType: "pi-hooks.second",
                    content: "Second message",
                },
                systemPrompt: "You are Pi. -> first -> second",
            })
            expect(sendMessage).not.toHaveBeenCalled()
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("warns and ignores malformed and unsupported before_agent_start stdout without blocking valid semantic effects", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

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
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "before_agent_start",
                                            output: {
                                                message: {
                                                    customType: "pi-hooks.first",
                                                    content: "First message",
                                                },
                                                systemPrompt: "You are Pi. -> first",
                                            },
                                        }),
                                    ),
                                },
                                { type: "command", command: createStdoutHookCommand("{not valid json") },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "before_agent_start",
                                            output: {
                                                messages: [
                                                    {
                                                        customType: "pi-hooks.invalid-array",
                                                        content: "bad",
                                                    },
                                                ],
                                            },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "before_agent_start",
                                            output: {
                                                message: {
                                                    customType: "pi-hooks.invalid-shape",
                                                },
                                            },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "before_agent_start",
                                            output: {
                                                foo: true,
                                            },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createLatestBeforeAgentStartHookCommand({
                                        messageType: "pi-hooks.second",
                                        messageContent: "Second message",
                                        systemPromptSuffix: " -> second",
                                    }),
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
            const { pi, handlers, sendMessage } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = getSessionStartHandler(handlers)
            const beforeAgentStart = getBeforeAgentStartHandler(handlers)
            const ctx = createExtensionContext(canonicalProjectDir)

            await sessionStart?.(
                { type: "session_start", reason: "startup" },
                createExtensionContext(canonicalProjectDir),
            )

            await expect(
                runBeforeAgentStartHandlers(
                    handlers,
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    ctx,
                ),
            ).resolves.toEqual({
                messages: [
                    {
                        customType: "pi-hooks.first",
                        content: "First message",
                    },
                    {
                        customType: "pi-hooks.second",
                        content: "Second message",
                    },
                ],
                systemPrompt: "You are Pi. -> first -> second",
            })
            await expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    ctx,
                ),
            ).resolves.toEqual({
                message: {
                    customType: "pi-hooks.second",
                    content: "Second message",
                },
                systemPrompt: "You are Pi. -> first -> second",
            })
            expect(sendMessage).not.toHaveBeenCalled()
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("Ignoring invalid hook stdout for before_agent_start"),
            )
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown property messages"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("must have required property 'content'"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown property foo"))
        } finally {
            warn.mockRestore()
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
                    version: 1,
                    event: "user_bash",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["npm test"] },
                    cwd: canonicalProjectDir,
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

    it("does not mutate before_agent_start events while awaiting semantic hook handling", async () => {
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

            await expect(
                beforeAgentStart?.(event, createExtensionContext(canonicalProjectDir)),
            ).resolves.toBeUndefined()
            expect(event).toEqual({
                type: "before_agent_start",
                prompt: "hello world",
                systemPrompt: "You are Pi.",
                systemPromptOptions: { cwd: canonicalProjectDir },
            })
            await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
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

            await expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
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

            await expect(
                beforeAgentStart?.(
                    {
                        type: "before_agent_start",
                        prompt: "hello world",
                        systemPrompt: "You are Pi.",
                        systemPromptOptions: { cwd: canonicalProjectDir },
                    },
                    createExtensionContext(join(canonicalProjectDir, "missing-cwd")),
                ),
            ).resolves.toBeUndefined()
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
                    version: 1,
                    event: "input",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["hello world"] },
                    cwd: canonicalProjectDir,
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

    it("returns transformed input from valid semantic stdout", async () => {
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
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "input",
                                            output: {
                                                action: "transform",
                                                text: "hello world from hook",
                                            },
                                        }),
                                    ),
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({
                action: "transform",
                text: "hello world from hook",
                images: undefined,
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("returns continue when valid semantic stdout leaves input unchanged", async () => {
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
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "input",
                                            output: { action: "continue" },
                                        }),
                                    ),
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({ action: "continue" })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("composes multiple valid input transforms in configured order over the latest state", async () => {
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
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "input",
                                            output: {
                                                action: "transform",
                                                text: "hello world + first",
                                            },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createLatestInputTransformHookCommand(" + second"),
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({
                action: "transform",
                text: "hello world + first + second",
                images: undefined,
            })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("stops input semantic processing at the first valid handled result while warning on malformed and unsupported stdout", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const afterHandledPath = join(projectDir, "input-after-handled.json")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    input: [
                        {
                            matcher: "hello world",
                            hooks: [
                                { type: "command", command: createStdoutHookCommand("{not valid json") },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "input",
                                            output: { systemPrompt: "not allowed" },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "input",
                                            output: { action: "transform", text: "hello world + first" },
                                        }),
                                    ),
                                },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({ version: 1, event: "input", output: { action: "handled" } }),
                                    ),
                                },
                                { type: "command", command: createNodeHookCommand(afterHandledPath) },
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({ action: "handled" })

            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid hook stdout for input"))
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("systemPrompt"))
            })
            await new Promise((resolve) => setTimeout(resolve, 50))
            await expect(readFile(afterHandledPath, "utf8")).rejects.toThrow()
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero input hook failures without crashing input handling", async () => {
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({ action: "continue" })
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command failed with exit code 7"))
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports input hook spawn failures without crashing input handling", async () => {
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(join(canonicalProjectDir, "missing-cwd")),
                ),
            ).resolves.toEqual({ action: "continue" })
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command failed before completion"))
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports timed out input hook failures without crashing input handling", async () => {
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

            await expect(
                input?.(
                    {
                        type: "input",
                        text: "hello world",
                        source: "interactive",
                        streamingBehavior: "followUp",
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toEqual({ action: "continue" })
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hook command timed out after 0.05s"))
        } finally {
            warn.mockRestore()
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("returns transformed tool input from valid semantic stdout", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "custom-tool",
                            hooks: [
                                { type: "command", command: createLatestToolCallInputHookCommand(" + transformed") },
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

            const event: ToolCallEvent = {
                type: "tool_call",
                toolCallId: "call-1",
                toolName: "custom-tool",
                input: { step: "draft" },
            }

            await expect(toolCall?.(event, createExtensionContext(canonicalProjectDir))).resolves.toBeUndefined()
            expect(event.input).toEqual({ step: "draft + transformed" })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("composes multiple valid tool_call input replacements in configured order over the latest state", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "custom-tool",
                            hooks: [
                                { type: "command", command: createLatestToolCallInputHookCommand(" + first") },
                                { type: "command", command: createLatestToolCallInputHookCommand(" + second") },
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

            const event: ToolCallEvent = {
                type: "tool_call",
                toolCallId: "call-1",
                toolName: "custom-tool",
                input: { step: "draft" },
            }

            await expect(toolCall?.(event, createExtensionContext(canonicalProjectDir))).resolves.toBeUndefined()
            expect(event.input).toEqual({ step: "draft + first + second" })
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("stops tool_call semantic processing at the first valid block while warning on malformed and unsupported stdout", async () => {
        const homeDir = await makeTempHome()
        const projectDir = join(homeDir, "workspace", "demo")
        const afterBlockPath = join(projectDir, "tool-call-after-block.json")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    tool_call: [
                        {
                            matcher: "custom-tool",
                            hooks: [
                                { type: "command", command: createStdoutHookCommand("{not valid json") },
                                {
                                    type: "command",
                                    command: createStdoutHookCommand(
                                        JSON.stringify({
                                            version: 1,
                                            event: "tool_call",
                                            output: { input: { step: "ignored" }, block: { reason: "bad" } },
                                        }),
                                    ),
                                },
                                { type: "command", command: createLatestToolCallBlockHookCommand("Blocked by hooks") },
                                { type: "command", command: createNodeHookCommand(afterBlockPath) },
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

            const event: ToolCallEvent = {
                type: "tool_call",
                toolCallId: "call-1",
                toolName: "custom-tool",
                input: { step: "draft" },
            }

            await expect(toolCall?.(event, createExtensionContext(canonicalProjectDir))).resolves.toEqual({
                block: true,
                reason: "Blocked by hooks",
            })
            expect(event.input).toEqual({ step: "draft" })
            await expect(readFile(afterBlockPath, "utf8")).rejects.toThrow()
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid hook stdout for tool_call"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("not valid json"))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("must match a schema in anyOf"))
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
                    version: 1,
                    event: "tool_call",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    cwd: canonicalProjectDir,
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
                    version: 1,
                    event: "tool_result",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    cwd: canonicalProjectDir,
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

    it("waits for tool_call semantic hooks before returning", async () => {
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

            await expect(
                toolCall?.(
                    {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toBeUndefined()
            await expect(readFile(outputPath, "utf8")).resolves.toBe("done")
        } finally {
            process.env.HOME = previousHome
            process.chdir(previousCwd)
        }
    })

    it("reports non-zero tool_call hook exits without blocking tool execution", async () => {
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

            await expect(
                toolCall?.(
                    {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
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
                    version: 1,
                    event: "tool_execution_start",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "tool_execution_start",
                        toolCallId: "call-1",
                        toolName: "read",
                        args: { path: "README.md" },
                    },
                })

                expect(JSON.parse(await readFile(updateOutputPath, "utf8"))).toEqual({
                    version: 1,
                    event: "tool_execution_update",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    cwd: canonicalProjectDir,
                    payload: {
                        type: "tool_execution_update",
                        toolCallId: "call-1",
                        toolName: "read",
                        args: { path: "README.md" },
                        partialResult: { chunk: "hello" },
                    },
                })

                expect(JSON.parse(await readFile(endOutputPath, "utf8"))).toEqual({
                    version: 1,
                    event: "tool_execution_end",
                    sourcePath: join(canonicalProjectDir, ".pi", "hooks.json"),
                    matcher: { kind: "exact", values: ["read"] },
                    cwd: canonicalProjectDir,
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

    it("reports timed out tool_call hooks without blocking tool execution", async () => {
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

            await expect(
                toolCall?.(
                    {
                        type: "tool_call",
                        toolCallId: "call-1",
                        toolName: "read",
                        input: { path: "README.md" },
                    },
                    createExtensionContext(canonicalProjectDir),
                ),
            ).resolves.toBeUndefined()
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
