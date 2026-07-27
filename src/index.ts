import { Ajv2020 } from "ajv/dist/2020.js"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ErrorObject, ValidateFunction } from "ajv"
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionStartEvent,
    ToolCallEvent,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

type SchemaDocument = {
    properties?: {
        hooks?: {
            properties?: Record<string, unknown>
        }
    }
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

type ToolNamedRuntimeEvent =
    | ToolCallEvent
    | ToolResultEvent
    | ToolExecutionStartEvent
    | ToolExecutionUpdateEvent
    | ToolExecutionEndEvent

export interface LoadedHook {
    enabled: true
    type: "command"
    command: string
    timeout?: number
    statusMessage?: string
}

export type LoadedMatcher = { kind: "all" } | { kind: "exact"; values: string[] } | { kind: "regex"; pattern: string }

export interface LoadedMatcherGroup {
    matcher: string | undefined
    normalizedMatcher: LoadedMatcher
    hooks: LoadedHook[]
}

export interface LoadedEventRegistration {
    eventName: string
    matcherGroups: LoadedMatcherGroup[]
}

export interface LoadedHooksFile {
    sourcePath: string
    events: LoadedEventRegistration[]
}

export interface HookRegistry {
    files: LoadedHooksFile[]
}

const EMPTY_REGISTRY: HookRegistry = { files: [] }
let activeRegistry: HookRegistry = EMPTY_REGISTRY

const hooksSchema = loadHooksSchema()
const validateHooksSchema = compileHooksSchemaValidator(hooksSchema)
const allowedEventNames = loadAllowedEventNames(hooksSchema)

export async function loadUserHooksRegistry(options: { homeDir?: string } = {}): Promise<HookRegistry> {
    const homeDir = options.homeDir ?? homedir()
    const sourcePath = join(homeDir, ".pi", "hooks.json")

    if (!(await fileExists(sourcePath))) {
        return EMPTY_REGISTRY
    }

    const loadedFile = await tryLoadDiscoveredHooksFile(sourcePath)
    return loadedFile === undefined ? EMPTY_REGISTRY : { files: [loadedFile] }
}

export async function loadHooksRegistry(options: { homeDir?: string; cwd?: string } = {}): Promise<HookRegistry> {
    const homeDir = options.homeDir ?? homedir()
    const cwd = resolve(options.cwd ?? process.cwd())
    const sourcePaths = await discoverHookFilePaths({ homeDir, cwd })
    const files: LoadedHooksFile[] = []

    for (const sourcePath of sourcePaths) {
        if (!(await fileExists(sourcePath))) {
            continue
        }

        const loadedFile = await tryLoadDiscoveredHooksFile(sourcePath)
        if (loadedFile !== undefined) {
            files.push(loadedFile)
        }
    }

    return { files }
}

export function getHookRegistry(): HookRegistry {
    return activeRegistry
}

export default function setup(pi: ExtensionAPI) {
    pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
        activeRegistry = await loadHooksRegistry({ cwd: ctx.cwd })
        dispatchSessionStartHooks(event, ctx)
    })

    pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
        dispatchToolCallHooks(event, ctx)
    })

    pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
        dispatchToolResultHooks(event, ctx)
    })

    pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
        dispatchToolExecutionStartHooks(event, ctx)
    })

    pi.on("tool_execution_update", (event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => {
        dispatchToolExecutionUpdateHooks(event, ctx)
    })

    pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
        dispatchToolExecutionEndHooks(event, ctx)
    })
}

async function discoverHookFilePaths(options: { homeDir: string; cwd: string }) {
    const seen = new Set<string>()
    const discoveredPaths: string[] = []

    const addPath = (path: string) => {
        if (seen.has(path)) {
            return
        }

        seen.add(path)
        discoveredPaths.push(path)
    }

    addPath(join(options.homeDir, ".pi", "hooks.json"))

    for (const directory of listAncestorDirectories(options.cwd)) {
        addPath(join(directory, ".pi", "hooks.json"))
    }

    return discoveredPaths
}

function listAncestorDirectories(cwd: string) {
    const absoluteCwd = isAbsolute(cwd) ? cwd : resolve(cwd)
    const segments = absoluteCwd.split("/").filter(Boolean)
    const directories = ["/"]
    let currentDirectory = ""

    for (const segment of segments) {
        currentDirectory = `${currentDirectory}/${segment}`
        directories.push(currentDirectory)
    }

    return directories
}

async function loadHooksFile(sourcePath: string): Promise<LoadedHooksFile> {
    const parsed = parseJsonObject(await readFile(sourcePath, "utf8"), sourcePath)
    validateParsedHooksFile(parsed, sourcePath)

    return {
        sourcePath,
        events: normalizeHooksFile(parsed, sourcePath),
    }
}

async function tryLoadDiscoveredHooksFile(sourcePath: string): Promise<LoadedHooksFile | undefined> {
    try {
        return await loadHooksFile(sourcePath)
    } catch (error) {
        if (!isSkippableDiscoveredFileError(error, sourcePath)) {
            throw error
        }

        console.warn((error as Error).message)
        return undefined
    }
}

async function fileExists(path: string) {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

function loadHooksSchema(): SchemaDocument {
    const schemaPath = fileURLToPath(new URL("../pi-hooks.schema.json", import.meta.url))
    return JSON.parse(readFileSync(schemaPath, "utf8")) as SchemaDocument
}

function compileHooksSchemaValidator(schema: SchemaDocument): ValidateFunction {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    return ajv.compile(schema)
}

function loadAllowedEventNames(schema: SchemaDocument) {
    return new Set(Object.keys(schema.properties?.hooks?.properties ?? {}))
}

function parseJsonObject(text: string, sourcePath: string) {
    let parsed: JsonValue

    try {
        parsed = JSON.parse(text) as JsonValue
    } catch (error) {
        throw new Error(`Invalid hooks.json at ${sourcePath}: ${(error as Error).message}`)
    }

    if (!isJsonObject(parsed)) {
        throw new Error(`Invalid hooks.json at ${sourcePath}: expected a JSON object`)
    }

    return parsed
}

function validateParsedHooksFile(parsed: JsonObject, sourcePath: string) {
    if (validateHooksSchema(parsed)) {
        return
    }

    const details = (validateHooksSchema.errors ?? []).map(formatSchemaError).join("; ")
    throw new Error(`Invalid hooks.json at ${sourcePath}: ${details || "schema validation failed"}`)
}

function formatSchemaError(error: ErrorObject) {
    if (error.keyword === "additionalProperties") {
        return `${error.instancePath || "/"} has unknown property ${String(error.params.additionalProperty)}`
    }

    return `${error.instancePath || "/"} ${error.message}`
}

function isSkippableDiscoveredFileError(error: unknown, sourcePath: string) {
    return error instanceof Error && error.message.startsWith(`Invalid hooks.json at ${sourcePath}:`)
}

function normalizeHooksFile(parsed: JsonObject, sourcePath: string) {
    const hooks = parsed.hooks
    if (!isJsonObject(hooks)) {
        throw new Error("Invalid hooks.json: hooks must be an object")
    }

    return Object.entries(hooks).map(([eventName, matcherGroups]) => ({
        eventName: normalizeEventName(eventName),
        matcherGroups: normalizeMatcherGroups(matcherGroups, { eventName, sourcePath }),
    }))
}

function normalizeEventName(eventName: string) {
    if (!allowedEventNames.has(eventName)) {
        throw new Error(`Invalid hooks.json: unsupported event ${eventName}`)
    }

    return eventName
}

function normalizeMatcherGroups(
    value: JsonValue,
    context: { eventName: string; sourcePath: string },
): LoadedMatcherGroup[] {
    if (!Array.isArray(value)) {
        throw new Error("Invalid hooks.json: event registrations must be arrays")
    }

    const matcherGroups: LoadedMatcherGroup[] = []

    for (const matcherGroup of value) {
        if (!isJsonObject(matcherGroup)) {
            throw new Error("Invalid hooks.json: matcher groups must be objects")
        }

        const matcher = matcherGroup.matcher
        if (matcher !== undefined && typeof matcher !== "string") {
            throw new Error("Invalid hooks.json: matcher must be a string when present")
        }

        try {
            matcherGroups.push({
                matcher,
                normalizedMatcher: normalizeMatcher(matcher),
                hooks: (matcherGroup.hooks as JsonValue[]).map(normalizeHook),
            })
        } catch (error) {
            console.warn(
                `Invalid matcher in hooks.json at ${context.sourcePath} for ${context.eventName}: ${matcher ?? "<omitted>"} (${(error as Error).message})`,
            )
        }
    }

    return matcherGroups
}

function normalizeMatcher(matcher: string | undefined): LoadedMatcher {
    if (matcher === undefined || matcher === "" || matcher === "*") {
        return { kind: "all" }
    }

    if (isExactMatcher(matcher)) {
        return { kind: "exact", values: matcher.split("|") }
    }

    try {
        new RegExp(matcher)
    } catch (error) {
        throw new Error((error as Error).message)
    }

    return { kind: "regex", pattern: matcher }
}

function isExactMatcher(matcher: string) {
    return matcher.split("|").every((candidate) => !hasRegexMetacharacters(candidate))
}

function hasRegexMetacharacters(value: string) {
    return /[\\^$.*+?()[\]{}]/.test(value)
}

function normalizeHook(value: JsonValue): LoadedHook {
    if (!isJsonObject(value)) {
        throw new Error("Invalid hooks.json: hooks must be objects")
    }

    if (value.type !== "command") {
        throw new Error("Invalid hooks.json: hook type must be command")
    }

    if (typeof value.command !== "string" || value.command.length === 0) {
        throw new Error("Invalid hooks.json: command hooks require a non-empty command")
    }

    return {
        enabled: true,
        type: "command",
        command: value.command,
        ...(value.timeout === undefined ? {} : { timeout: value.timeout as number }),
        ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage as string }),
    }
}

function dispatchSessionStartHooks(event: SessionStartEvent, ctx: ExtensionContext) {
    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "session_start") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesSessionStartReason(matcherGroup.normalizedMatcher, event.reason)) {
                    continue
                }

                for (const hook of matcherGroup.hooks) {
                    void runCommandHook({
                        hook,
                        cwd: ctx.cwd,
                        payload: {
                            event: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            payload: serializeJsonObject(event),
                        },
                    }).catch((error: unknown) => {
                        console.warn(
                            `Hook command failed before completion: ${hook.command} (${toErrorMessage(error)})`,
                        )
                    })
                }
            }
        }
    }
}

function dispatchToolCallHooks(event: ToolCallEvent, ctx: ExtensionContext) {
    dispatchToolNamedHooks("tool_call", event, ctx)
}

function dispatchToolResultHooks(event: ToolResultEvent, ctx: ExtensionContext) {
    dispatchToolNamedHooks("tool_result", event, ctx)
}

function dispatchToolExecutionStartHooks(event: ToolExecutionStartEvent, ctx: ExtensionContext) {
    dispatchToolNamedHooks("tool_execution_start", event, ctx)
}

function dispatchToolExecutionUpdateHooks(event: ToolExecutionUpdateEvent, ctx: ExtensionContext) {
    dispatchToolNamedHooks("tool_execution_update", event, ctx)
}

function dispatchToolExecutionEndHooks(event: ToolExecutionEndEvent, ctx: ExtensionContext) {
    dispatchToolNamedHooks("tool_execution_end", event, ctx)
}

function dispatchToolNamedHooks(
    eventName: "tool_call" | "tool_result" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end",
    event: ToolNamedRuntimeEvent,
    ctx: ExtensionContext,
) {
    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== eventName) {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.toolName)) {
                    continue
                }

                for (const hook of matcherGroup.hooks) {
                    void runCommandHook({
                        hook,
                        cwd: ctx.cwd,
                        payload: {
                            event: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            payload: serializeJsonObject(event),
                        },
                    }).catch((error: unknown) => {
                        console.warn(
                            `Hook command failed before completion: ${hook.command} (${toErrorMessage(error)})`,
                        )
                    })
                }
            }
        }
    }
}

function matchesSessionStartReason(matcher: LoadedMatcher, reason: SessionStartEvent["reason"]) {
    return matchesLoadedMatcher(matcher, reason)
}

function matchesLoadedMatcher(matcher: LoadedMatcher, value: string) {
    if (matcher.kind === "all") {
        return true
    }

    if (matcher.kind === "exact") {
        return matcher.values.includes(value)
    }

    return new RegExp(matcher.pattern).test(value)
}

async function runCommandHook(options: { hook: LoadedHook; cwd: string; payload: JsonObject }) {
    const child = spawn(options.hook.command, {
        cwd: options.cwd,
        env: process.env,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    let timedOut = false
    const timeoutMilliseconds =
        options.hook.timeout === undefined ? undefined : Math.max(0, options.hook.timeout * 1000)
    const timeoutHandle =
        timeoutMilliseconds === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true
                  child.kill()
              }, timeoutMilliseconds)

    child.stdout.on("data", (chunk: Uint8Array) => {
        stdoutChunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Uint8Array) => {
        stderrChunks.push(chunk)
    })

    child.stdin.end(JSON.stringify(options.payload))

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", (error) => {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle)
            }
            reject(error)
        })
        child.on("close", (code) => {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle)
            }
            resolve(code)
        })
    })

    const stdout = Buffer.concat(stdoutChunks).toString("utf8")
    const stderr = Buffer.concat(stderrChunks).toString("utf8")

    if (timedOut) {
        console.warn(
            `Hook command timed out after ${options.hook.timeout}s: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`,
        )
        return
    }

    if (exitCode === 0) {
        return
    }

    console.warn(
        `Hook command failed with exit code ${exitCode ?? "unknown"}: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`,
    )
}

function serializeJsonObject(value: unknown): JsonObject {
    return JSON.parse(JSON.stringify(value)) as JsonObject
}

function toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
