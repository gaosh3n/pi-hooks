import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import setup, { getHookRegistry, loadHooksRegistry, loadUserHooksRegistry, type HookRegistry } from "../src/index.ts"

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

            const sessionStart = handlers.session_start as
                | ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>)
                | undefined

            expect(sessionStart).toBeTypeOf("function")

            await sessionStart?.({ type: "session_start", reason: "startup" }, {} as ExtensionContext)
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

            const sessionStart = handlers.session_start as
                | ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>)
                | undefined

            await sessionStart?.({ type: "session_start", reason: "startup" }, {} as ExtensionContext)

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
