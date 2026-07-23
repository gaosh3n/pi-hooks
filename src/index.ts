import { Ajv2020 } from "ajv/dist/2020.js"
import { readFileSync } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ErrorObject, ValidateFunction } from "ajv"
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

type SchemaDocument = {
    properties?: {
        hooks?: {
            properties?: Record<string, unknown>
        }
    }
}

export interface LoadedHook {
    enabled: true
    type: "command"
    command: string
    timeout?: number
    statusMessage?: string
}

export interface LoadedMatcherGroup {
    matcher: string | undefined
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

    const loadedFile = await loadHooksFile(sourcePath)
    return { files: [loadedFile] }
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

        files.push(await loadHooksFile(sourcePath))
    }

    return { files }
}

export function getHookRegistry(): HookRegistry {
    return activeRegistry
}

export default function setup(pi: ExtensionAPI) {
    pi.on("session_start", async (_event: SessionStartEvent, _ctx: ExtensionContext) => {
        activeRegistry = await loadHooksRegistry()
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
        events: normalizeHooksFile(parsed),
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

function normalizeHooksFile(parsed: JsonObject) {
    const hooks = parsed.hooks
    if (!isJsonObject(hooks)) {
        throw new Error("Invalid hooks.json: hooks must be an object")
    }

    return Object.entries(hooks).map(([eventName, matcherGroups]) => ({
        eventName: normalizeEventName(eventName),
        matcherGroups: normalizeMatcherGroups(matcherGroups),
    }))
}

function normalizeEventName(eventName: string) {
    if (!allowedEventNames.has(eventName)) {
        throw new Error(`Invalid hooks.json: unsupported event ${eventName}`)
    }

    return eventName
}

function normalizeMatcherGroups(value: JsonValue): LoadedMatcherGroup[] {
    if (!Array.isArray(value)) {
        throw new Error("Invalid hooks.json: event registrations must be arrays")
    }

    return value.map((matcherGroup) => {
        if (!isJsonObject(matcherGroup)) {
            throw new Error("Invalid hooks.json: matcher groups must be objects")
        }

        const matcher = matcherGroup.matcher
        if (matcher !== undefined && typeof matcher !== "string") {
            throw new Error("Invalid hooks.json: matcher must be a string when present")
        }

        return {
            matcher,
            hooks: (matcherGroup.hooks as JsonValue[]).map(normalizeHook),
        }
    })
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
