import { Ajv2020 } from "ajv/dist/2020.js"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
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
    model: unknown
    previousModel: unknown
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

type SessionShutdownEvent = {
    type: "session_shutdown"
    reason: "quit" | "reload" | "new" | "resume" | "fork"
    targetSessionFile?: string
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

type ReasonMatchedEventName =
    | "resources_discover"
    | "session_start"
    | "session_before_switch"
    | "session_before_compact"
    | "session_compact"
    | "session_shutdown"

type ReasonMatchedRuntimeEvent =
    | ResourcesDiscoverEvent
    | SessionStartEvent
    | SessionBeforeSwitchEvent
    | SessionBeforeCompactEvent
    | SessionCompactEvent
    | SessionShutdownEvent

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

type HookCancellationReason = "abort" | "shutdown" | "timeout"

type ActiveHookExecution = {
    child: ChildProcessWithoutNullStreams
    cancellationReason: HookCancellationReason | undefined
    clearAbortListener: (() => void) | undefined
}

const EMPTY_REGISTRY: HookRegistry = { files: [] }
let activeRegistry: HookRegistry = EMPTY_REGISTRY
let activeHookExecutions = new Set<ActiveHookExecution>()

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

    pi.on(
        "project_trust",
        async (event: ProjectTrustEvent, ctx: ProjectTrustContext): Promise<ProjectTrustEventResult> => {
            const registry = await loadUserHooksRegistry()
            dispatchProjectTrustHooks(event, ctx, registry)
            return { trusted: "undecided" }
        },
    )

    pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
        dispatchModelSelectHooks(event, ctx)
    })

    pi.on("thinking_level_select", (event: ThinkingLevelSelectEvent, ctx: ExtensionContext) => {
        dispatchThinkingLevelSelectHooks(event, ctx)
    })

    pi.on("resources_discover", (event: ResourcesDiscoverEvent, ctx: ExtensionContext) => {
        dispatchResourcesDiscoverHooks(event, ctx)
    })

    pi.on("session_before_switch", (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
        dispatchSessionBeforeSwitchHooks(event, ctx)
    })

    pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
        dispatchSessionBeforeCompactHooks(event, ctx)
    })

    pi.on("session_compact", (event: SessionCompactEvent, ctx: ExtensionContext) => {
        dispatchSessionCompactHooks(event, ctx)
    })

    pi.on("session_shutdown", (event: SessionShutdownEvent, ctx: ExtensionContext) => {
        const registryAtShutdown = activeRegistry
        activeRegistry = EMPTY_REGISTRY
        cancelActiveHookExecutions("shutdown")
        dispatchSessionShutdownHooks(event, ctx, registryAtShutdown)
    })

    pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
        dispatchBeforeAgentStartHooks(event, ctx)
    })

    pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
        dispatchInputHooks(event, ctx)
    })

    pi.on("user_bash", (event: UserBashEvent, ctx: ExtensionContext) => {
        dispatchUserBashHooks(event, ctx)
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
    dispatchReasonMatchedHooks("session_start", event, ctx)
}

function cancelActiveHookExecutions(reason: HookCancellationReason) {
    const executions = [...activeHookExecutions]
    activeHookExecutions = new Set()

    for (const execution of executions) {
        if (execution.cancellationReason !== undefined) {
            continue
        }

        execution.cancellationReason = reason
        execution.clearAbortListener?.()
        execution.clearAbortListener = undefined
        execution.child.kill()
    }
}

function dispatchProjectTrustHooks(event: ProjectTrustEvent, ctx: ProjectTrustContext, registry: HookRegistry) {
    for (const file of registry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "project_trust") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.cwd)) {
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

function dispatchModelSelectHooks(event: ModelSelectEvent, ctx: ExtensionContext) {
    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "model_select") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.source)) {
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
                        abortSignal: getHookAbortSignal(event, ctx),
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

function dispatchThinkingLevelSelectHooks(event: ThinkingLevelSelectEvent, ctx: ExtensionContext) {
    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "thinking_level_select") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.level)) {
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
                        abortSignal: getHookAbortSignal(event, ctx),
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

function dispatchResourcesDiscoverHooks(event: ResourcesDiscoverEvent, ctx: ExtensionContext) {
    dispatchReasonMatchedHooks("resources_discover", event, ctx)
}

function dispatchSessionBeforeSwitchHooks(event: SessionBeforeSwitchEvent, ctx: ExtensionContext) {
    dispatchReasonMatchedHooks("session_before_switch", event, ctx)
}

function dispatchSessionBeforeCompactHooks(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
    dispatchReasonMatchedHooks("session_before_compact", event, ctx)
}

function dispatchSessionCompactHooks(event: SessionCompactEvent, ctx: ExtensionContext) {
    dispatchReasonMatchedHooks("session_compact", event, ctx)
}

function dispatchSessionShutdownHooks(
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
    registry: HookRegistry = activeRegistry,
) {
    dispatchReasonMatchedHooks("session_shutdown", event, ctx, registry)
}

function dispatchReasonMatchedHooks(
    eventName: ReasonMatchedEventName,
    event: ReasonMatchedRuntimeEvent,
    ctx: ExtensionContext,
    registry: HookRegistry = activeRegistry,
) {
    for (const file of registry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== eventName) {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.reason)) {
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
                        abortSignal: getHookAbortSignal(event, ctx),
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

function dispatchBeforeAgentStartHooks(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
    dispatchTextMatchedHooks({
        eventName: "before_agent_start",
        event,
        subject: event.prompt,
        ctx,
        reportFailures: true,
    })
}

function dispatchInputHooks(event: InputEvent, ctx: ExtensionContext) {
    dispatchTextMatchedHooks({
        eventName: "input",
        event,
        subject: event.text,
        ctx,
        reportFailures: false,
    })
}

function dispatchUserBashHooks(event: UserBashEvent, ctx: ExtensionContext) {
    dispatchTextMatchedHooks({
        eventName: "user_bash",
        event,
        subject: event.command,
        ctx,
        reportFailures: true,
    })
}

function dispatchTextMatchedHooks(options: {
    eventName: "before_agent_start" | "input" | "user_bash"
    event: BeforeAgentStartEvent | InputEvent | UserBashEvent
    subject: string
    ctx: ExtensionContext
    reportFailures: boolean
}) {
    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== options.eventName) {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, options.subject)) {
                    continue
                }

                for (const hook of matcherGroup.hooks) {
                    void runCommandHook({
                        hook,
                        cwd: options.ctx.cwd,
                        payload: {
                            event: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            payload: serializeJsonObject(options.event),
                        },
                        reportFailures: options.reportFailures,
                        abortSignal: getHookAbortSignal(options.event, options.ctx),
                    }).catch((error: unknown) => {
                        if (!options.reportFailures) {
                            return
                        }

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
                        abortSignal: getHookAbortSignal(event, ctx),
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

function matchesLoadedMatcher(matcher: LoadedMatcher, value: string) {
    if (matcher.kind === "all") {
        return true
    }

    if (matcher.kind === "exact") {
        return matcher.values.includes(value)
    }

    return new RegExp(matcher.pattern).test(value)
}

function getHookAbortSignal(event: unknown, ctx: ExtensionContext) {
    const eventSignalCandidate = (event as { signal?: unknown }).signal
    if (isAbortSignal(eventSignalCandidate)) {
        return eventSignalCandidate
    }

    return ctx.signal
}

function isAbortSignal(value: unknown): value is AbortSignal {
    return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value
}

async function runCommandHook(options: {
    hook: LoadedHook
    cwd: string
    payload: JsonObject
    reportFailures?: boolean
    abortSignal?: AbortSignal
}) {
    const child = spawn(options.hook.command, {
        cwd: options.cwd,
        env: process.env,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Uint8Array[] = []
    const stderrChunks: Uint8Array[] = []
    const reportFailures = options.reportFailures ?? true
    const activeExecution: ActiveHookExecution = {
        child,
        cancellationReason: undefined,
        clearAbortListener: undefined,
    }
    activeHookExecutions.add(activeExecution)

    const timeoutMilliseconds =
        options.hook.timeout === undefined ? undefined : Math.max(0, options.hook.timeout * 1000)
    const timeoutHandle =
        timeoutMilliseconds === undefined
            ? undefined
            : setTimeout(() => {
                  if (activeExecution.cancellationReason !== undefined) {
                      return
                  }

                  activeExecution.cancellationReason = "timeout"
                  child.kill()
              }, timeoutMilliseconds)

    const clearExecution = () => {
        activeHookExecutions.delete(activeExecution)
        activeExecution.clearAbortListener?.()
        activeExecution.clearAbortListener = undefined
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle)
        }
    }

    if (options.abortSignal !== undefined) {
        const abortHook = () => {
            if (activeExecution.cancellationReason !== undefined) {
                return
            }

            activeExecution.cancellationReason = "abort"
            child.kill()
        }

        if (options.abortSignal.aborted) {
            abortHook()
        } else {
            options.abortSignal.addEventListener("abort", abortHook, { once: true })
            activeExecution.clearAbortListener = () => {
                options.abortSignal?.removeEventListener("abort", abortHook)
            }
        }
    }

    child.stdout.on("data", (chunk: Uint8Array) => {
        stdoutChunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Uint8Array) => {
        stderrChunks.push(chunk)
    })

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", (error) => {
            clearExecution()
            reject(error)
        })
        child.stdin.on("error", (error) => {
            clearExecution()
            reject(error)
        })
        child.on("close", (code) => {
            clearExecution()
            resolve(code)
        })

        child.stdin.end(JSON.stringify(options.payload))
    })

    const stdout = Buffer.concat(stdoutChunks).toString("utf8")
    const stderr = Buffer.concat(stderrChunks).toString("utf8")

    if (activeExecution.cancellationReason === "timeout") {
        if (reportFailures) {
            console.warn(
                `Hook command timed out after ${options.hook.timeout}s: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`,
            )
        }
        return
    }

    if (activeExecution.cancellationReason === "abort") {
        if (reportFailures) {
            console.warn(`Hook command aborted: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`)
        }
        return
    }

    if (activeExecution.cancellationReason === "shutdown") {
        return
    }

    if (exitCode === 0) {
        return
    }

    if (reportFailures) {
        console.warn(
            `Hook command failed with exit code ${exitCode ?? "unknown"}: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`,
        )
    }
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
