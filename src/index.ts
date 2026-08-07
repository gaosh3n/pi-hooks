import { Ajv2020 } from "ajv/dist/2020.js"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFileSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ErrorObject, ValidateFunction } from "ajv"
import type {
    BeforeAgentStartEventResult,
    ExtensionAPI,
    ExtensionContext,
    InputEventResult,
    SessionStartEvent,
    ToolCallEvent,
    ToolCallEventResult,
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

type MatchAllOnlyEventName =
    | "session_info_changed"
    | "session_before_fork"
    | "session_before_tree"
    | "session_tree"
    | "context"
    | "before_provider_request"
    | "before_provider_headers"
    | "after_provider_response"
    | "agent_start"
    | "agent_end"
    | "agent_settled"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"

type MatchAllOnlyRuntimeEvent =
    | SessionInfoChangedEvent
    | SessionBeforeForkEvent
    | SessionBeforeTreeEvent
    | SessionTreeEvent
    | ContextEvent
    | BeforeProviderRequestEvent
    | BeforeProviderHeadersEvent
    | AfterProviderResponseEvent
    | AgentStartEvent
    | AgentEndEvent
    | AgentSettledEvent
    | TurnStartEvent
    | TurnEndEvent
    | MessageStartEvent
    | MessageUpdateEvent
    | MessageEndEvent

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

type HookStdinEnvelope = {
    version: 1
    event: string
    sourcePath: string
    matcher: LoadedMatcher
    cwd: string
    payload: JsonObject
}

type HookStdoutEnvelope = {
    version: 1
    event: string
    output: JsonObject
}

type HookStdoutParseResult =
    | { kind: "empty" }
    | { kind: "invalid"; warning: string }
    | { kind: "valid"; envelope: HookStdoutEnvelope }

type InputHookResult =
    | { action: "continue" }
    | { action: "transform"; text: string; images?: unknown[] }
    | { action: "handled" }

type BeforeAgentStartHookResult = BeforeAgentStartEventResult

type ToolCallHookResult =
    | { input: JsonObject }
    | {
          block: {
              reason?: string
          }
      }

type ToolResultEventResult = {
    content?: unknown[]
    details?: unknown
    isError?: boolean
}

type ToolResultHookResult = ToolResultEventResult

type BeforeAgentStartHookSlot = {
    sourcePath: string
    matcher: LoadedMatcher
    hook: LoadedHook
}

type ActiveHookExecution = {
    child: ChildProcessWithoutNullStreams
    cancellationReason: HookCancellationReason | undefined
    clearAbortListener: (() => void) | undefined
}

type HookStatusSink = {
    setStatus(key: string, text: string | undefined): void
}

type HookNotifyLevel = "info" | "warning" | "error"

type HookNotifySink = {
    notify(message: string, level?: HookNotifyLevel): void
}

type HookRunRecord = {
    id: string
    eventName: string
    statusMessage: string | undefined
    startedAt: number
    displayOrder: number
}

type HookRunStatus = "running" | "completed" | "failed" | "blocked" | "stopped"

type HookOutputEntryKind = "warning" | "stop" | "feedback" | "context" | "error"

type HookOutputEntry = {
    kind: HookOutputEntryKind
    text: string
}

type FinalizedHookRun = {
    id: string
    eventName: string
    status: HookRunStatus
    reason: string | undefined
    startedAt: number
    completedAt: number
    displayOrder: number
    statusMessage: string | undefined
    entries: HookOutputEntry[]
}

const HOOK_PROTOCOL_VERSION = 1 as const
const HOOK_STATUS_KEY = "pi-hooks"
const SEMANTIC_STDOUT_EVENT_NAMES = new Set(["input", "before_agent_start", "tool_call", "tool_result"])
const emptyHookOutputSchema = {
    type: "object",
    additionalProperties: false,
} as const
const permissiveHookOutputSchema = {
    type: "object",
} as const
const inputHookOutputSchema = {
    anyOf: [
        {
            type: "object",
            required: ["action"],
            additionalProperties: false,
            properties: {
                action: { const: "continue" },
            },
        },
        {
            type: "object",
            required: ["action", "text"],
            additionalProperties: false,
            properties: {
                action: { const: "transform" },
                text: { type: "string" },
                images: { type: "array", items: {} },
            },
        },
        {
            type: "object",
            required: ["action"],
            additionalProperties: false,
            properties: {
                action: { const: "handled" },
            },
        },
    ],
} as const
const beforeAgentStartHookOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        message: {
            type: "object",
            required: ["customType", "content"],
            additionalProperties: false,
            properties: {
                customType: { type: "string" },
                content: {},
                display: { type: "boolean" },
                details: {},
            },
        },
        systemPrompt: { type: "string" },
    },
    anyOf: [{ required: ["message"] }, { required: ["systemPrompt"] }],
} as const
const toolCallHookOutputSchema = {
    anyOf: [
        {
            type: "object",
            required: ["input"],
            additionalProperties: false,
            properties: {
                input: {
                    type: "object",
                },
            },
        },
        {
            type: "object",
            required: ["block"],
            additionalProperties: false,
            properties: {
                block: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        reason: { type: "string" },
                    },
                },
            },
        },
    ],
} as const
const toolResultHookOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        content: {
            type: "array",
            items: {
                anyOf: [
                    {
                        type: "object",
                        required: ["type", "text"],
                        additionalProperties: false,
                        properties: {
                            type: { const: "text" },
                            text: { type: "string" },
                        },
                    },
                    {
                        type: "object",
                        required: ["type", "source"],
                        additionalProperties: false,
                        properties: {
                            type: { const: "image" },
                            source: {
                                type: "object",
                                required: ["type", "mediaType", "data"],
                                additionalProperties: false,
                                properties: {
                                    type: { const: "base64" },
                                    mediaType: { type: "string" },
                                    data: { type: "string" },
                                },
                            },
                        },
                    },
                ],
            },
        },
        details: {},
        isError: { type: "boolean" },
    },
    anyOf: [{ required: ["content"] }, { required: ["details"] }, { required: ["isError"] }],
} as const
const hookStdoutEnvelopeSchema = {
    type: "object",
    required: ["version", "event", "output"],
    additionalProperties: false,
    properties: {
        version: { const: HOOK_PROTOCOL_VERSION },
        event: { type: "string" },
        output: { type: "object" },
    },
} as const

const EMPTY_REGISTRY: HookRegistry = { files: [] }
let activeRegistry: HookRegistry = EMPTY_REGISTRY
let activeBeforeAgentStartSlots: BeforeAgentStartHookSlot[] = []
let activeHookExecutions = new Set<ActiveHookExecution>()
let activeHookRuns = new Map<string, HookRunRecord>()
let nextHookRunDisplayOrder = 0
let lastHookStatusSink: HookStatusSink | undefined
let finalizedHookRuns = new Map<string, FinalizedHookRun>()
let lastHookNotifySink: HookNotifySink | undefined
let hookInvalidStdoutCounts = new Map<string, number>()
let hookInvalidStdoutNotified = new Set<string>()
const HOOK_INVALID_STDOUT_NOTIFY_THRESHOLD = 2

const hooksSchema = loadHooksSchema()
const validateHooksSchema = compileJsonSchemaValidator(hooksSchema)
const validateHookStdoutEnvelope = compileJsonSchemaValidator(hookStdoutEnvelopeSchema)
const allowedEventNames = loadAllowedEventNames(hooksSchema)
const validateHookStdoutOutputByEvent = compileHookStdoutOutputValidators(allowedEventNames)

export async function loadUserHooksRegistry(
    options: { homeDir?: string; notifyUi?: unknown } = {},
): Promise<HookRegistry> {
    const homeDir = options.homeDir ?? homedir()
    const sourcePath = join(homeDir, ".pi", "hooks.json")

    if (!(await fileExists(sourcePath))) {
        return EMPTY_REGISTRY
    }

    const loadedFile = await tryLoadDiscoveredHooksFile(sourcePath, { notifyUi: options.notifyUi })
    return loadedFile === undefined ? EMPTY_REGISTRY : { files: [loadedFile] }
}

export async function loadHooksRegistry(
    options: { homeDir?: string; cwd?: string; notifyUi?: unknown } = {},
): Promise<HookRegistry> {
    const homeDir = options.homeDir ?? homedir()
    const cwd = resolve(options.cwd ?? process.cwd())
    const sourcePaths = await discoverHookFilePaths({ homeDir, cwd })
    const files: LoadedHooksFile[] = []

    for (const sourcePath of sourcePaths) {
        if (!(await fileExists(sourcePath))) {
            continue
        }

        const loadedFile = await tryLoadDiscoveredHooksFile(sourcePath, { notifyUi: options.notifyUi })
        if (loadedFile !== undefined) {
            files.push(loadedFile)
        }
    }

    return { files }
}

export function getHookRegistry(): HookRegistry {
    return activeRegistry
}

function compileBeforeAgentStartHookSlots(registry: HookRegistry): BeforeAgentStartHookSlot[] {
    const slots: BeforeAgentStartHookSlot[] = []

    for (const file of registry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "before_agent_start") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                for (const hook of matcherGroup.hooks) {
                    slots.push({
                        sourcePath: file.sourcePath,
                        matcher: matcherGroup.normalizedMatcher,
                        hook,
                    })
                }
            }
        }
    }

    return slots
}

export default function setup(pi: ExtensionAPI) {
    let registeredBeforeAgentStartSlotCount = 0

    const ensureBeforeAgentStartSlotHandlers = (slotCount: number) => {
        while (registeredBeforeAgentStartSlotCount < slotCount) {
            const slotIndex = registeredBeforeAgentStartSlotCount
            pi.on(
                "before_agent_start",
                async (
                    event: BeforeAgentStartEvent,
                    ctx: ExtensionContext,
                ): Promise<BeforeAgentStartEventResult | undefined> => {
                    return await dispatchBeforeAgentStartHookSlot(slotIndex, event, ctx)
                },
            )
            registeredBeforeAgentStartSlotCount += 1
        }
    }

    pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
        activeRegistry = await loadHooksRegistry({ cwd: ctx.cwd, notifyUi: ctx.ui })
        activeBeforeAgentStartSlots = compileBeforeAgentStartHookSlots(activeRegistry)
        ensureBeforeAgentStartSlotHandlers(activeBeforeAgentStartSlots.length)
        finalizedHookRuns.clear()
        hookInvalidStdoutCounts.clear()
        hookInvalidStdoutNotified.clear()
        dispatchSessionStartHooks(event, ctx)
    })

    pi.on(
        "project_trust",
        async (event: ProjectTrustEvent, ctx: ProjectTrustContext): Promise<ProjectTrustEventResult> => {
            const registry = await loadUserHooksRegistry({ notifyUi: ctx.ui })
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

    pi.on("session_info_changed", (event: SessionInfoChangedEvent, ctx: ExtensionContext) => {
        dispatchSessionInfoChangedHooks(event, ctx)
    })

    pi.on("session_before_switch", (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
        dispatchSessionBeforeSwitchHooks(event, ctx)
    })

    pi.on("session_before_fork", (event: SessionBeforeForkEvent, ctx: ExtensionContext) => {
        dispatchSessionBeforeForkHooks(event, ctx)
    })

    pi.on("session_before_tree", (event: SessionBeforeTreeEvent, ctx: ExtensionContext) => {
        dispatchSessionBeforeTreeHooks(event, ctx)
    })

    pi.on("session_tree", (event: SessionTreeEvent, ctx: ExtensionContext) => {
        dispatchSessionTreeHooks(event, ctx)
    })

    pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
        dispatchContextHooks(event, ctx)
    })

    pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
        dispatchBeforeProviderRequestHooks(event, ctx)
    })

    pi.on("before_provider_headers", (event: BeforeProviderHeadersEvent, ctx: ExtensionContext) => {
        dispatchBeforeProviderHeadersHooks(event, ctx)
    })

    pi.on("after_provider_response", (event: AfterProviderResponseEvent, ctx: ExtensionContext) => {
        dispatchAfterProviderResponseHooks(event, ctx)
    })

    pi.on("agent_start", (event: AgentStartEvent, ctx: ExtensionContext) => {
        dispatchAgentStartHooks(event, ctx)
    })

    pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
        dispatchAgentEndHooks(event, ctx)
    })

    pi.on("agent_settled", (event: AgentSettledEvent, ctx: ExtensionContext) => {
        dispatchAgentSettledHooks(event, ctx)
    })

    pi.on("turn_start", (event: TurnStartEvent, ctx: ExtensionContext) => {
        dispatchTurnStartHooks(event, ctx)
    })

    pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
        dispatchTurnEndHooks(event, ctx)
    })

    pi.on("message_start", (event: MessageStartEvent, ctx: ExtensionContext) => {
        dispatchMessageStartHooks(event, ctx)
    })

    pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
        dispatchMessageUpdateHooks(event, ctx)
    })

    pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
        dispatchMessageEndHooks(event, ctx)
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
        activeBeforeAgentStartSlots = []
        cancelActiveHookExecutions("shutdown")
        activeHookRuns.clear()
        finalizedHookRuns.clear()
        hookInvalidStdoutCounts.clear()
        hookInvalidStdoutNotified.clear()
        renderHookStatus()
        lastHookStatusSink = undefined
        lastHookNotifySink = undefined
        nextHookRunDisplayOrder = 0
        dispatchSessionShutdownHooks(event, ctx, registryAtShutdown)
    })

    pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
        const result = await dispatchInputHooks(event, ctx)
        return result as InputEventResult
    })

    pi.on("user_bash", (event: UserBashEvent, ctx: ExtensionContext) => {
        dispatchUserBashHooks(event, ctx)
    })

    pi.on(
        "tool_call",
        async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
            return dispatchToolCallHooks(event, ctx)
        },
    )

    ;(
        pi as ExtensionAPI & {
            on(
                event: "tool_result",
                handler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultEventResult | undefined>,
            ): void
        }
    ).on(
        "tool_result",
        async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
            return dispatchToolResultHooks(event, ctx)
        },
    )

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

async function loadHooksFile(sourcePath: string, options: { notifyUi?: unknown } = {}): Promise<LoadedHooksFile> {
    const parsed = parseJsonObject(await readFile(sourcePath, "utf8"), sourcePath)
    validateParsedHooksFile(parsed, sourcePath)

    return {
        sourcePath,
        events: normalizeHooksFile(parsed, sourcePath, { notifyUi: options.notifyUi }),
    }
}

async function tryLoadDiscoveredHooksFile(
    sourcePath: string,
    options: { notifyUi?: unknown } = {},
): Promise<LoadedHooksFile | undefined> {
    try {
        return await loadHooksFile(sourcePath, options)
    } catch (error) {
        if (!isSkippableDiscoveredFileError(error, sourcePath)) {
            throw error
        }

        reportWarning((error as Error).message, { notifyUi: options.notifyUi })
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

function compileJsonSchemaValidator(schema: object): ValidateFunction {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    return ajv.compile(schema)
}

function loadAllowedEventNames(schema: SchemaDocument) {
    return new Set(Object.keys(schema.properties?.hooks?.properties ?? {}))
}

function compileHookStdoutOutputValidators(eventNames: Set<string>) {
    return new Map(
        [...eventNames].map((eventName) => [
            eventName,
            compileJsonSchemaValidator(getHookStdoutOutputSchema(eventName)),
        ]),
    )
}

function getHookStdoutOutputSchema(eventName: string) {
    if (eventName === "input") {
        return inputHookOutputSchema
    }

    if (eventName === "before_agent_start") {
        return beforeAgentStartHookOutputSchema
    }

    if (eventName === "tool_call") {
        return toolCallHookOutputSchema
    }

    if (eventName === "tool_result") {
        return toolResultHookOutputSchema
    }

    if (SEMANTIC_STDOUT_EVENT_NAMES.has(eventName)) {
        return permissiveHookOutputSchema
    }

    return emptyHookOutputSchema
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

function normalizeHooksFile(parsed: JsonObject, sourcePath: string, options: { notifyUi?: unknown } = {}) {
    const hooks = parsed.hooks
    if (!isJsonObject(hooks)) {
        throw new Error("Invalid hooks.json: hooks must be an object")
    }

    return Object.entries(hooks).map(([eventName, matcherGroups]) => ({
        eventName: normalizeEventName(eventName),
        matcherGroups: normalizeMatcherGroups(matcherGroups, { eventName, sourcePath, notifyUi: options.notifyUi }),
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
    context: { eventName: string; sourcePath: string; notifyUi?: unknown },
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
                normalizedMatcher: normalizeMatcherForEvent(matcher, context),
                hooks: (matcherGroup.hooks as JsonValue[]).map(normalizeHook),
            })
        } catch (error) {
            reportWarning(
                `Invalid matcher in hooks.json at ${context.sourcePath} for ${context.eventName}: ${matcher ?? "<omitted>"} (${(error as Error).message})`,
                { notifyUi: context.notifyUi },
            )
        }
    }

    return matcherGroups
}

function normalizeMatcherForEvent(
    matcher: string | undefined,
    context: { eventName: string; sourcePath: string; notifyUi?: unknown },
): LoadedMatcher {
    if (!isMatchAllOnlyEvent(context.eventName)) {
        return normalizeMatcher(matcher)
    }

    if (matcher === undefined) {
        return { kind: "all" }
    }

    reportWarning(
        `Ignoring matcher in hooks.json at ${context.sourcePath} for ${context.eventName}: ${matcher} (event is match-all-only)`,
        { notifyUi: context.notifyUi },
    )
    return { kind: "all" }
}

function isMatchAllOnlyEvent(eventName: string): eventName is MatchAllOnlyEventName {
    return (
        eventName === "session_info_changed" ||
        eventName === "session_before_fork" ||
        eventName === "session_before_tree" ||
        eventName === "session_tree" ||
        eventName === "context" ||
        eventName === "before_provider_request" ||
        eventName === "before_provider_headers" ||
        eventName === "after_provider_response" ||
        eventName === "agent_start" ||
        eventName === "agent_end" ||
        eventName === "agent_settled" ||
        eventName === "turn_start" ||
        eventName === "turn_end" ||
        eventName === "message_start" ||
        eventName === "message_update" ||
        eventName === "message_end"
    )
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

function getHookStatusSink(value: unknown): HookStatusSink | undefined {
    if (typeof value !== "object" || value === null || !("setStatus" in value)) {
        return undefined
    }

    return typeof value.setStatus === "function" ? (value as HookStatusSink) : undefined
}

function getHookNotifySink(value: unknown): HookNotifySink | undefined {
    if (typeof value !== "object" || value === null || !("notify" in value)) {
        return undefined
    }

    return typeof value.notify === "function" ? (value as HookNotifySink) : undefined
}

function isStaleContextError(error: unknown) {
    return error instanceof Error && /stale/i.test(error.message)
}

function safeNotify(notifyUi: unknown, message: string, level: HookNotifyLevel = "info") {
    const notifySink = getHookNotifySink(notifyUi)
    if (notifySink === undefined) {
        return false
    }

    try {
        notifySink.notify(message, level)
        return true
    } catch (error) {
        if (!isStaleContextError(error)) {
            throw error
        }

        return false
    }
}

function reportWarning(message: string, options: { notifyUi?: unknown; level?: HookNotifyLevel } = {}) {
    safeNotify(options.notifyUi ?? lastHookNotifySink, message, options.level ?? "warning")
}

function reportHookCommandFailureBeforeCompletion(notifyUi: unknown, command: string, error: unknown) {
    reportWarning(`Hook command failed before completion: ${command} (${toErrorMessage(error)})`, {
        notifyUi,
    })
}

function startHookRun(options: { eventName: string; statusMessage: string | undefined; statusUi?: unknown }) {
    const statusSink = getHookStatusSink(options.statusUi)
    if (statusSink !== undefined) {
        lastHookStatusSink = statusSink
    }

    const notifySink = getHookNotifySink(options.statusUi)
    if (notifySink !== undefined) {
        lastHookNotifySink = notifySink
    }

    const displayOrder = nextHookRunDisplayOrder
    nextHookRunDisplayOrder += 1

    const run: HookRunRecord = {
        id: `hook-run-${displayOrder}`,
        eventName: options.eventName,
        statusMessage: options.statusMessage,
        startedAt: Date.now(),
        displayOrder,
    }

    activeHookRuns.set(run.id, run)
    renderHookStatus()
    return run.id
}

function finishHookRun(
    runId: string,
    finalization: { status: HookRunStatus; reason?: string; entries?: HookOutputEntry[] },
) {
    const activeRun = activeHookRuns.get(runId)
    if (activeRun === undefined) {
        return
    }

    activeHookRuns.delete(runId)
    const finalizedRun: FinalizedHookRun = {
        id: activeRun.id,
        eventName: activeRun.eventName,
        status: finalization.status,
        reason: finalization.reason,
        startedAt: activeRun.startedAt,
        completedAt: Date.now(),
        displayOrder: activeRun.displayOrder,
        statusMessage: activeRun.statusMessage,
        entries: finalization.entries ?? [],
    }
    finalizedHookRuns.set(runId, finalizedRun)
    notifyOnFinalize(finalizedRun)
    renderHookStatus()
}

function notifyOnFinalize(run: FinalizedHookRun) {
    if (lastHookNotifySink === undefined) {
        return
    }

    if (run.status === "completed" || run.status === "running") {
        return
    }

    if (run.status === "stopped") {
        return
    }

    const isImportantSeam = SEMANTIC_STDOUT_EVENT_NAMES.has(
        run.eventName as "input" | "before_agent_start" | "tool_call" | "tool_result",
    )

    if (run.status === "blocked") {
        safeNotify(lastHookNotifySink, `Hook ${run.eventName} blocked`, "warning")
        return
    }

    if (!isImportantSeam) {
        return
    }

    if (run.reason === "invalid_stdout") {
        const count = (hookInvalidStdoutCounts.get(run.eventName) ?? 0) + 1
        hookInvalidStdoutCounts.set(run.eventName, count)
        if (count < HOOK_INVALID_STDOUT_NOTIFY_THRESHOLD || hookInvalidStdoutNotified.has(run.eventName)) {
            return
        }

        hookInvalidStdoutNotified.add(run.eventName)
    }

    safeNotify(
        lastHookNotifySink,
        `Hook ${run.eventName} ${run.status}${run.reason === undefined ? "" : `: ${run.reason}`}`,
        "warning",
    )
}

export function getFinalizedHookRuns(): FinalizedHookRun[] {
    return [...finalizedHookRuns.values()].sort((left, right) => {
        if (left.completedAt !== right.completedAt) {
            return left.completedAt - right.completedAt
        }

        if (left.displayOrder !== right.displayOrder) {
            return left.displayOrder - right.displayOrder
        }

        return left.id.localeCompare(right.id)
    })
}

function renderHookStatus() {
    if (lastHookStatusSink === undefined) {
        return
    }

    const activeRuns = [...activeHookRuns.values()].sort((left, right) => {
        if (left.startedAt !== right.startedAt) {
            return left.startedAt - right.startedAt
        }

        if (left.displayOrder !== right.displayOrder) {
            return left.displayOrder - right.displayOrder
        }

        return left.id.localeCompare(right.id)
    })

    if (activeRuns.length === 0) {
        lastHookStatusSink.setStatus(HOOK_STATUS_KEY, undefined)
        return
    }

    if (activeRuns.length === 1) {
        lastHookStatusSink.setStatus(HOOK_STATUS_KEY, getHookRunStatusLabel(activeRuns[0]))
        return
    }

    const leadRun = activeRuns[0]
    lastHookStatusSink.setStatus(
        HOOK_STATUS_KEY,
        `Running ${activeRuns.length} hooks: ${getHookRunStatusLabel(leadRun)} (+${activeRuns.length - 1} more)`,
    )
}

function getHookRunStatusLabel(run: HookRunRecord) {
    return run.statusMessage ?? `Running ${run.eventName} hook`
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

function createHookStdinEnvelope(options: {
    eventName: string
    sourcePath: string
    matcher: LoadedMatcher
    cwd: string
    event: unknown
}): HookStdinEnvelope {
    return {
        version: HOOK_PROTOCOL_VERSION,
        event: options.eventName,
        sourcePath: options.sourcePath,
        matcher: options.matcher,
        cwd: options.cwd,
        payload: serializeJsonObject(options.event),
    }
}

function parseHookStdout(options: { stdout: string; eventName: string }): HookStdoutParseResult {
    if (options.stdout.trim() === "") {
        return { kind: "empty" }
    }

    let parsed: JsonValue

    try {
        parsed = JSON.parse(options.stdout) as JsonValue
    } catch (error) {
        return {
            kind: "invalid",
            warning: `Ignoring invalid hook stdout for ${options.eventName}: ${(error as Error).message}`,
        }
    }

    if (!isJsonObject(parsed)) {
        return {
            kind: "invalid",
            warning: `Ignoring invalid hook stdout for ${options.eventName}: expected a JSON object`,
        }
    }

    if (!validateHookStdoutEnvelope(parsed)) {
        const details = (validateHookStdoutEnvelope.errors ?? []).map(formatSchemaError).join("; ")
        return {
            kind: "invalid",
            warning: `Ignoring invalid hook stdout for ${options.eventName}: ${details || "schema validation failed"}`,
        }
    }

    if (parsed.event !== options.eventName) {
        return {
            kind: "invalid",
            warning: `Ignoring invalid hook stdout for ${options.eventName}: envelope event ${parsed.event} does not match fired event`,
        }
    }

    const validateOutput = validateHookStdoutOutputByEvent.get(options.eventName)
    if (validateOutput === undefined) {
        return {
            kind: "invalid",
            warning: `Ignoring invalid hook stdout for ${options.eventName}: unsupported event`,
        }
    }

    if (!validateOutput(parsed.output)) {
        const details = (validateOutput.errors ?? []).map(formatSchemaError).join("; ")
        return {
            kind: "invalid",
            warning: `Ignoring invalid hook stdout for ${options.eventName}: ${details || "output validation failed"}`,
        }
    }

    return { kind: "valid", envelope: parsed as HookStdoutEnvelope }
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
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: ctx.cwd,
                            event,
                        }),
                        statusUi: ctx.ui,
                    }).catch((error: unknown) => {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
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
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: ctx.cwd,
                            event,
                        }),
                        abortSignal: getHookAbortSignal(event, ctx),
                        statusUi: ctx.ui,
                    }).catch((error: unknown) => {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
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
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: ctx.cwd,
                            event,
                        }),
                        abortSignal: getHookAbortSignal(event, ctx),
                        statusUi: ctx.ui,
                    }).catch((error: unknown) => {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                    })
                }
            }
        }
    }
}

function dispatchResourcesDiscoverHooks(event: ResourcesDiscoverEvent, ctx: ExtensionContext) {
    dispatchReasonMatchedHooks("resources_discover", event, ctx)
}

function dispatchSessionInfoChangedHooks(event: SessionInfoChangedEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("session_info_changed", event, ctx)
}

function dispatchSessionBeforeSwitchHooks(event: SessionBeforeSwitchEvent, ctx: ExtensionContext) {
    dispatchReasonMatchedHooks("session_before_switch", event, ctx)
}

function dispatchSessionBeforeForkHooks(event: SessionBeforeForkEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("session_before_fork", event, ctx)
}

function dispatchSessionBeforeTreeHooks(event: SessionBeforeTreeEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("session_before_tree", event, ctx)
}

function dispatchSessionTreeHooks(event: SessionTreeEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("session_tree", event, ctx)
}

function dispatchContextHooks(event: ContextEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("context", event, ctx)
}

function dispatchBeforeProviderRequestHooks(event: BeforeProviderRequestEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("before_provider_request", event, ctx)
}

function dispatchBeforeProviderHeadersHooks(event: BeforeProviderHeadersEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("before_provider_headers", event, ctx)
}

function dispatchAfterProviderResponseHooks(event: AfterProviderResponseEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("after_provider_response", event, ctx)
}

function dispatchAgentStartHooks(event: AgentStartEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("agent_start", event, ctx)
}

function dispatchAgentEndHooks(event: AgentEndEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("agent_end", event, ctx)
}

function dispatchAgentSettledHooks(event: AgentSettledEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("agent_settled", event, ctx)
}

function dispatchTurnStartHooks(event: TurnStartEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("turn_start", event, ctx)
}

function dispatchTurnEndHooks(event: TurnEndEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("turn_end", event, ctx)
}

function dispatchMessageStartHooks(event: MessageStartEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("message_start", event, ctx)
}

function dispatchMessageUpdateHooks(event: MessageUpdateEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("message_update", event, ctx)
}

function dispatchMessageEndHooks(event: MessageEndEvent, ctx: ExtensionContext) {
    dispatchMatchAllHooks("message_end", event, ctx)
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
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: ctx.cwd,
                            event,
                        }),
                        abortSignal: getHookAbortSignal(event, ctx),
                        statusUi: ctx.ui,
                    }).catch((error: unknown) => {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                    })
                }
            }
        }
    }
}

function dispatchMatchAllHooks(
    eventName: MatchAllOnlyEventName,
    event: MatchAllOnlyRuntimeEvent,
    ctx: ExtensionContext,
) {
    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== eventName) {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                for (const hook of matcherGroup.hooks) {
                    void runCommandHook({
                        hook,
                        cwd: ctx.cwd,
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: ctx.cwd,
                            event,
                        }),
                        abortSignal: getHookAbortSignal(event, ctx),
                        statusUi: ctx.ui,
                    }).catch((error: unknown) => {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                    })
                }
            }
        }
    }
}

async function dispatchBeforeAgentStartHookSlot(
    slotIndex: number,
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
    const slot = activeBeforeAgentStartSlots[slotIndex]
    if (slot === undefined) {
        return undefined
    }

    if (!matchesLoadedMatcher(slot.matcher, event.prompt)) {
        return undefined
    }

    let stdoutEnvelope: HookStdoutEnvelope | undefined

    try {
        stdoutEnvelope = await runCommandHook({
            hook: slot.hook,
            cwd: ctx.cwd,
            payload: createHookStdinEnvelope({
                eventName: "before_agent_start",
                sourcePath: slot.sourcePath,
                matcher: slot.matcher,
                cwd: ctx.cwd,
                event,
            }),
            reportFailures: true,
            abortSignal: getHookAbortSignal(event, ctx),
            consumeStdout: true,
            statusUi: ctx.ui,
        })
    } catch (error) {
        reportHookCommandFailureBeforeCompletion(ctx.ui, slot.hook.command, error)
        return undefined
    }

    if (stdoutEnvelope === undefined) {
        return undefined
    }

    const output = stdoutEnvelope.output as BeforeAgentStartHookResult
    if (output.message === undefined && output.systemPrompt === undefined) {
        return undefined
    }

    return output
}

async function dispatchInputHooks(event: InputEvent, ctx: ExtensionContext): Promise<InputHookResult> {
    let currentText = event.text
    let currentImages = event.images

    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "input") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, currentText)) {
                    continue
                }

                for (const hook of matcherGroup.hooks) {
                    let stdoutEnvelope: HookStdoutEnvelope | undefined

                    try {
                        stdoutEnvelope = await runCommandHook({
                            hook,
                            cwd: ctx.cwd,
                            payload: createHookStdinEnvelope({
                                eventName: registration.eventName,
                                sourcePath: file.sourcePath,
                                matcher: matcherGroup.normalizedMatcher,
                                cwd: ctx.cwd,
                                event: {
                                    ...event,
                                    text: currentText,
                                    images: currentImages,
                                },
                            }),
                            reportFailures: true,
                            abortSignal: getHookAbortSignal(event, ctx),
                            consumeStdout: true,
                            statusUi: ctx.ui,
                            classifyOutput: (envelope) => {
                                const output = envelope.output as InputHookResult
                                if (output.action === "handled") {
                                    return { entries: [{ kind: "stop", text: "input handled by hook" }] }
                                }

                                return {}
                            },
                        })
                    } catch (error) {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                        continue
                    }

                    if (stdoutEnvelope === undefined) {
                        continue
                    }

                    const output = stdoutEnvelope.output as InputHookResult
                    if (output.action === "handled") {
                        return output
                    }

                    if (output.action === "transform") {
                        currentText = output.text
                        currentImages = output.images ?? currentImages
                    }
                }
            }
        }
    }

    return currentText !== event.text || currentImages !== event.images
        ? { action: "transform", text: currentText, images: currentImages }
        : { action: "continue" }
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
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: options.ctx.cwd,
                            event: options.event,
                        }),
                        reportFailures: options.reportFailures,
                        abortSignal: getHookAbortSignal(options.event, options.ctx),
                        statusUi: options.ctx.ui,
                    }).catch((error: unknown) => {
                        if (!options.reportFailures) {
                            return
                        }

                        reportHookCommandFailureBeforeCompletion(options.ctx.ui, hook.command, error)
                    })
                }
            }
        }
    }
}

async function dispatchToolCallHooks(
    event: ToolCallEvent,
    ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
    let currentInput = serializeJsonObject(event.input)

    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "tool_call") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.toolName)) {
                    continue
                }

                for (const hook of matcherGroup.hooks) {
                    let stdoutEnvelope: HookStdoutEnvelope | undefined

                    try {
                        stdoutEnvelope = await runCommandHook({
                            hook,
                            cwd: ctx.cwd,
                            payload: createHookStdinEnvelope({
                                eventName: registration.eventName,
                                sourcePath: file.sourcePath,
                                matcher: matcherGroup.normalizedMatcher,
                                cwd: ctx.cwd,
                                event: {
                                    ...event,
                                    input: currentInput,
                                },
                            }),
                            reportFailures: true,
                            abortSignal: getHookAbortSignal(event, ctx),
                            consumeStdout: true,
                            statusUi: ctx.ui,
                            classifyOutput: (envelope) => {
                                const output = envelope.output as ToolCallHookResult
                                if ("block" in output) {
                                    return {
                                        status: "blocked",
                                        entries: [{ kind: "feedback", text: output.block.reason ?? "" }],
                                    }
                                }

                                return {}
                            },
                        })
                    } catch (error) {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                        continue
                    }

                    if (stdoutEnvelope === undefined) {
                        continue
                    }

                    const output = stdoutEnvelope.output as ToolCallHookResult
                    if ("block" in output) {
                        return {
                            block: true,
                            ...(output.block.reason === undefined ? {} : { reason: output.block.reason }),
                        }
                    }

                    currentInput = output.input
                }
            }
        }
    }

    replaceObjectContents(event.input as Record<string, unknown>, currentInput)
    return undefined
}

async function dispatchToolResultHooks(
    event: ToolResultEvent,
    ctx: ExtensionContext,
): Promise<ToolResultEventResult | undefined> {
    let currentContent = serializeJsonArray(event.content)
    let currentDetails = serializeJsonValue(event.details)
    let currentIsError = event.isError

    for (const file of activeRegistry.files) {
        for (const registration of file.events) {
            if (registration.eventName !== "tool_result") {
                continue
            }

            for (const matcherGroup of registration.matcherGroups) {
                if (!matchesLoadedMatcher(matcherGroup.normalizedMatcher, event.toolName)) {
                    continue
                }

                for (const hook of matcherGroup.hooks) {
                    let stdoutEnvelope: HookStdoutEnvelope | undefined

                    try {
                        stdoutEnvelope = await runCommandHook({
                            hook,
                            cwd: ctx.cwd,
                            payload: createHookStdinEnvelope({
                                eventName: registration.eventName,
                                sourcePath: file.sourcePath,
                                matcher: matcherGroup.normalizedMatcher,
                                cwd: ctx.cwd,
                                event: {
                                    ...event,
                                    content: currentContent,
                                    details: currentDetails,
                                    isError: currentIsError,
                                },
                            }),
                            reportFailures: true,
                            abortSignal: getHookAbortSignal(event, ctx),
                            consumeStdout: true,
                            statusUi: ctx.ui,
                        })
                    } catch (error) {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                        continue
                    }

                    if (stdoutEnvelope === undefined) {
                        continue
                    }

                    const output = stdoutEnvelope.output as ToolResultHookResult
                    if (output.content !== undefined) {
                        currentContent = serializeJsonArray(output.content)
                    }

                    if (Object.prototype.hasOwnProperty.call(output, "details")) {
                        currentDetails = serializeJsonValue(output.details)
                    }

                    if (output.isError !== undefined) {
                        currentIsError = output.isError
                    }
                }
            }
        }
    }

    const result: ToolResultEventResult = {}
    if (!jsonValuesEqual(currentContent, serializeJsonArray(event.content))) {
        result.content = currentContent as ToolResultEventResult["content"]
    }
    if (!jsonValuesEqual(currentDetails, serializeJsonValue(event.details))) {
        result.details = currentDetails
    }
    if (currentIsError !== event.isError) {
        result.isError = currentIsError
    }

    return Object.keys(result).length === 0 ? undefined : result
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
                        payload: createHookStdinEnvelope({
                            eventName: registration.eventName,
                            sourcePath: file.sourcePath,
                            matcher: matcherGroup.normalizedMatcher,
                            cwd: ctx.cwd,
                            event,
                        }),
                        abortSignal: getHookAbortSignal(event, ctx),
                        statusUi: ctx.ui,
                    }).catch((error: unknown) => {
                        reportHookCommandFailureBeforeCompletion(ctx.ui, hook.command, error)
                    })
                }
            }
        }
    }
}

function replaceObjectContents(target: Record<string, unknown>, replacement: JsonObject) {
    for (const key of Object.keys(target)) {
        delete target[key]
    }

    Object.assign(target, replacement)
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
    payload: HookStdinEnvelope
    reportFailures?: boolean
    abortSignal?: AbortSignal
    consumeStdout?: boolean
    statusUi?: unknown
    classifyOutput?: (envelope: HookStdoutEnvelope) => { status?: HookRunStatus; entries?: HookOutputEntry[] }
}): Promise<HookStdoutEnvelope | undefined> {
    const hookRunId = startHookRun({
        eventName: options.payload.event,
        statusMessage: options.hook.statusMessage,
        statusUi: options.statusUi,
    })
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

    let finalization: { status: HookRunStatus; reason?: string; entries?: HookOutputEntry[] } = {
        status: "completed",
        entries: [],
    }

    try {
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
                reportWarning(
                    `Hook command timed out after ${options.hook.timeout}s: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`,
                )
            }
            finalization = { status: "stopped", reason: "timeout", entries: [] }
            return
        }

        if (activeExecution.cancellationReason === "abort") {
            if (reportFailures) {
                reportWarning(`Hook command aborted: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`)
            }
            finalization = { status: "stopped", reason: "abort", entries: [] }
            return
        }

        if (activeExecution.cancellationReason === "shutdown") {
            finalization = { status: "stopped", reason: "shutdown", entries: [] }
            return
        }

        if (exitCode === 0) {
            const parsedStdout = parseHookStdout({ stdout, eventName: options.payload.event })
            if (parsedStdout.kind === "invalid") {
                reportWarning(`${parsedStdout.warning}\nstdout: ${stdout}\nstderr: ${stderr}`)
                finalization = {
                    status: "failed",
                    reason: "invalid_stdout",
                    entries: [{ kind: "error", text: parsedStdout.warning }],
                }
                return
            }

            if (parsedStdout.kind === "valid") {
                if (options.consumeStdout) {
                    if (options.classifyOutput !== undefined) {
                        const semantic = options.classifyOutput(parsedStdout.envelope)
                        if (semantic.status !== undefined) {
                            finalization.status = semantic.status
                        }

                        if (semantic.entries !== undefined) {
                            finalization.entries = semantic.entries
                        }
                    }

                    return parsedStdout.envelope
                }

                reportWarning(
                    `Ignoring hook stdout for ${options.payload.event}: semantic output is not supported yet\nstdout: ${stdout}\nstderr: ${stderr}`,
                )
                return parsedStdout.envelope
            }

            return
        }

        if (reportFailures) {
            reportWarning(
                `Hook command failed with exit code ${exitCode ?? "unknown"}: ${options.hook.command}\nstdout: ${stdout}\nstderr: ${stderr}`,
            )
        }

        finalization = {
            status: "failed",
            reason: "nonzero_exit",
            entries: [{ kind: "error", text: `hook command exited with exit code ${exitCode ?? "unknown"}` }],
        }
    } catch (error) {
        if (activeExecution.cancellationReason !== undefined) {
            finalization = {
                status: "stopped",
                reason: activeExecution.cancellationReason,
                entries: [],
            }
            return
        }

        const reason = /stdin/i.test(toErrorMessage(error)) ? "stdin_error" : "spawn_error"
        finalization = {
            status: "failed",
            reason,
            entries: [{ kind: "error", text: toErrorMessage(error) }],
        }
        throw error
    } finally {
        finishHookRun(hookRunId, finalization)
    }
}

function serializeJsonObject(value: unknown): JsonObject {
    return JSON.parse(JSON.stringify(value)) as JsonObject
}

function serializeJsonArray(value: unknown): JsonValue[] {
    return JSON.parse(JSON.stringify(value)) as JsonValue[]
}

function serializeJsonValue(value: unknown): JsonValue | undefined {
    if (value === undefined) {
        return undefined
    }

    return JSON.parse(JSON.stringify(value)) as JsonValue
}

function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined) {
    return JSON.stringify(left) === JSON.stringify(right)
}

function toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
