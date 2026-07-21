import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import setup, { getHookRegistry, loadUserHooksRegistry, type HookRegistry } from "../src/index.ts"

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

        expect(registry).toEqual<HookRegistry>({
            files: [
                {
                    sourcePath: join(homeDir, ".pi", "hooks.json"),
                    events: [
                        {
                            eventName: "session_start",
                            matcherGroups: [
                                {
                                    matcher: undefined,
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

    it("rejects a hooks.json with extra root properties", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
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

        await expect(loadUserHooksRegistry({ homeDir })).rejects.toThrow(/unexpected/)
    })

    it("rejects a hooks.json with empty hooks object", async () => {
        const homeDir = await makeTempHome()
        await writeFile(join(homeDir, ".pi", "hooks.json"), JSON.stringify({ hooks: {} }))

        await expect(loadUserHooksRegistry({ homeDir })).rejects.toThrow(/hooks/)
    })

    it("rejects a matcher group with an empty hooks array", async () => {
        const homeDir = await makeTempHome()
        await writeFile(
            join(homeDir, ".pi", "hooks.json"),
            JSON.stringify({
                hooks: {
                    session_start: [
                        {
                            hooks: [],
                        },
                    ],
                },
            }),
        )

        await expect(loadUserHooksRegistry({ homeDir })).rejects.toThrow(/hooks/)
    })

    it("rejects a handler with extra properties", async () => {
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
                                    extra: true,
                                },
                            ],
                        },
                    ],
                },
            }),
        )

        await expect(loadUserHooksRegistry({ homeDir })).rejects.toThrow(/extra/)
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

        const previousHome = process.env.HOME
        process.env.HOME = homeDir

        try {
            const { pi, handlers } = createExtensionApiDouble()
            setup(pi)

            const sessionStart = handlers.session_start as
                | ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>)
                | undefined

            expect(sessionStart).toBeTypeOf("function")

            await sessionStart?.({ type: "session_start", reason: "startup" }, {} as ExtensionContext)

            expect(getHookRegistry()).toEqual<HookRegistry>({
                files: [
                    {
                        sourcePath: join(homeDir, ".pi", "hooks.json"),
                        events: [
                            {
                                eventName: "session_start",
                                matcherGroups: [
                                    {
                                        matcher: undefined,
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
        }
    })

    it("exports a setup function", () => {
        expect(setup).toBeTypeOf("function")
    })
})
