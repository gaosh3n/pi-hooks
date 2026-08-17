#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const HOOK_MSG_PREFIX = "PI_HOOK_MSG:"
const homeDir = os.homedir()
const cwd = process.cwd()

function emitHookMessage(message, level = "info") {
    process.stderr.write(`${HOOK_MSG_PREFIX}${JSON.stringify({ message, level })}\n`)
}

function expandHome(inputPath) {
    if (inputPath === "~") {
        return homeDir
    }
    if (inputPath.startsWith("~/")) {
        return path.join(homeDir, inputPath.slice(2))
    }
    return inputPath
}

function toDisplayPath(inputPath) {
    if (inputPath === homeDir) {
        return "~"
    }
    if (inputPath.startsWith(`${homeDir}/`)) {
        return `~/${inputPath.slice(homeDir.length + 1)}`
    }
    return inputPath
}

async function readJsonIfExists(filePath) {
    if (!existsSync(filePath)) {
        return undefined
    }

    try {
        return JSON.parse(await readFile(filePath, "utf8"))
    } catch (error) {
        emitHookMessage(`Pi resources: ignoring invalid JSON at ${toDisplayPath(filePath)}`, "info")
        return undefined
    }
}

function resolveSettingPaths(value, baseDir) {
    if (!Array.isArray(value)) {
        return []
    }

    return value
        .filter((item) => typeof item === "string" && item.trim().length > 0)
        .map((item) => {
            const expanded = expandHome(item)
            return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded)
        })
}

function resolvePackageSources(value) {
    if (!Array.isArray(value)) {
        return []
    }

    return value.flatMap((item) => {
        if (typeof item === "string" && item.trim().length > 0) {
            return [item]
        }
        if (
            typeof item === "object" &&
            item !== null &&
            typeof item.source === "string" &&
            item.source.trim().length > 0
        ) {
            return [item.source]
        }
        return []
    })
}

async function loadConfiguredPaths() {
    const globalSettingsPath = path.join(homeDir, ".pi", "agent", "settings.json")
    const projectSettingsPath = path.join(cwd, ".pi", "settings.json")

    const globalSettings = await readJsonIfExists(globalSettingsPath)
    const projectSettings = await readJsonIfExists(projectSettingsPath)

    return {
        extensionPaths: [
            ...resolveSettingPaths(globalSettings?.extensions, path.dirname(globalSettingsPath)),
            ...resolveSettingPaths(projectSettings?.extensions, path.dirname(projectSettingsPath)),
        ],
        packageSources: [
            ...resolvePackageSources(globalSettings?.packages),
            ...resolvePackageSources(projectSettings?.packages),
        ],
        skillPaths: [
            ...resolveSettingPaths(globalSettings?.skills, path.dirname(globalSettingsPath)),
            ...resolveSettingPaths(projectSettings?.skills, path.dirname(projectSettingsPath)),
        ],
    }
}

async function loadInstalledSkillSourceLabels() {
    const skillLockPath = path.join(homeDir, ".agents", ".skill-lock.json")
    const skillLock = await readJsonIfExists(skillLockPath)
    const sourceLabels = new Map()

    for (const [skillName, metadata] of Object.entries(skillLock?.skills ?? {})) {
        if (typeof skillName !== "string" || typeof metadata !== "object" || metadata === null) {
            continue
        }
        if (metadata.sourceType === "github" && typeof metadata.source === "string" && metadata.source.length > 0) {
            sourceLabels.set(skillName, `github.com/${metadata.source}`)
        }
    }

    return sourceLabels
}

function getGitRoot(startDir) {
    const result = spawnSync("git", ["-C", startDir, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    })

    if (result.status === 0) {
        const gitRoot = result.stdout.trim()
        if (gitRoot.length > 0) {
            return gitRoot
        }
    }

    return undefined
}

function getAncestorDirs(startDir, stopDir) {
    const dirs = []
    let current = path.resolve(startDir)
    const resolvedStopDir = stopDir === undefined ? undefined : path.resolve(stopDir)

    while (true) {
        dirs.push(current)
        if (resolvedStopDir !== undefined && current === resolvedStopDir) {
            break
        }
        const parent = path.dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }

    return dirs
}

async function listDirSafe(dirPath) {
    try {
        return await readdir(dirPath, { withFileTypes: true })
    } catch {
        return []
    }
}

async function collectExtensionFilesFromRoot(rootPath, sink) {
    for (const entry of await listDirSafe(rootPath)) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
            sink.add(path.join(rootPath, entry.name))
            continue
        }
        if (!entry.isDirectory()) {
            continue
        }
        const nestedIndex = path.join(rootPath, entry.name, "index.ts")
        if (existsSync(nestedIndex)) {
            sink.add(nestedIndex)
        }
    }
}

async function collectExtensionFilesFromExplicitPath(inputPath, sink) {
    if (!existsSync(inputPath)) {
        return
    }

    const statEntries = await listDirSafe(inputPath)
    if (statEntries.length > 0) {
        const nestedIndex = path.join(inputPath, "index.ts")
        if (existsSync(nestedIndex)) {
            sink.add(nestedIndex)
        }
        for (const entry of statEntries) {
            if (entry.isFile() && entry.name.endsWith(".ts")) {
                sink.add(path.join(inputPath, entry.name))
            }
        }
        return
    }

    if (inputPath.endsWith(".ts")) {
        sink.add(inputPath)
    }
}

async function collectSkillFilesFromTree(rootPath, sink) {
    if (!existsSync(rootPath)) {
        return
    }

    for (const entry of await listDirSafe(rootPath)) {
        const fullPath = path.join(rootPath, entry.name)
        if (!entry.isDirectory()) {
            continue
        }
        const skillFile = path.join(fullPath, "SKILL.md")
        if (existsSync(skillFile)) {
            sink.add(skillFile)
        }
        await collectSkillFilesFromTree(fullPath, sink)
    }
}

async function collectSkillFilesFromRoot(rootPath, sink, options = { allowRootMdFiles: false }) {
    if (!existsSync(rootPath)) {
        return
    }

    for (const entry of await listDirSafe(rootPath)) {
        const fullPath = path.join(rootPath, entry.name)
        if (entry.isFile() && options.allowRootMdFiles && entry.name.endsWith(".md")) {
            sink.add(fullPath)
            continue
        }
        if (!entry.isDirectory()) {
            continue
        }
        const skillFile = path.join(fullPath, "SKILL.md")
        if (existsSync(skillFile)) {
            sink.add(skillFile)
        }
        await collectSkillFilesFromTree(fullPath, sink)
    }
}

async function collectSkillFilesFromExplicitPath(inputPath, sink) {
    if (!existsSync(inputPath)) {
        return
    }

    if (inputPath.endsWith(".md")) {
        sink.add(inputPath)
        return
    }

    const nestedSkill = path.join(inputPath, "SKILL.md")
    if (existsSync(nestedSkill)) {
        sink.add(nestedSkill)
    }
    await collectSkillFilesFromTree(inputPath, sink)
}

async function parseSkillName(skillFilePath) {
    const fallback =
        path.basename(skillFilePath) === "SKILL.md"
            ? path.basename(path.dirname(skillFilePath))
            : path.basename(skillFilePath, path.extname(skillFilePath))

    try {
        const text = await readFile(skillFilePath, "utf8")
        const frontmatterMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
        if (frontmatterMatch === null) {
            return fallback
        }
        const nameMatch = frontmatterMatch[1].match(/(?:^|\n)name:\s*["']?([^\n"']+)["']?\s*(?:\n|$)/)
        return nameMatch?.[1]?.trim() || fallback
    } catch {
        return fallback
    }
}

function extensionNameFromPath(extensionPath) {
    return path.basename(extensionPath) === "index.ts"
        ? path.basename(path.dirname(extensionPath))
        : path.basename(extensionPath, path.extname(extensionPath))
}

function uniqueSorted(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function formatIndentedSection(title, values) {
    const lines = [title]
    if (values.length === 0) {
        lines.push("  - none")
        return lines.join("\n")
    }

    for (const value of values) {
        lines.push(`  - ${value}`)
    }
    return lines.join("\n")
}

function formatGroupedSection(title, groupedValues) {
    const lines = [title]
    if (groupedValues.length === 0) {
        lines.push("  - none")
        return lines.join("\n")
    }

    for (const group of groupedValues) {
        lines.push(`  - ${group.label}`)
    }
    return lines.join("\n")
}

function inferSkillSourceLabel(skillFilePath, skillName, installedSkillSourceLabels) {
    const installedSourceLabel = installedSkillSourceLabels.get(skillName)
    if (installedSourceLabel !== undefined) {
        return installedSourceLabel
    }

    const normalizedPath = path.resolve(skillFilePath)
    const repoMatch = normalizedPath.match(/\/(?:\.pi\/agent\/git|\.cache\/checkouts)\/([^/]+\/[^/]+\/[^/]+)(?:\/|$)/)
    if (repoMatch !== null) {
        return repoMatch[1]
    }

    for (const marker of ["/.pi/agent/skills/", "/.agents/skills/", "/.pi/skills/", "/.agents/skills/"]) {
        const markerIndex = normalizedPath.indexOf(marker)
        if (markerIndex !== -1) {
            return toDisplayPath(normalizedPath.slice(0, markerIndex + marker.length - 1))
        }
    }

    return toDisplayPath(path.dirname(normalizedPath))
}

async function discoverExtensions(configuredPaths) {
    const extensionFiles = new Set()

    for (const rootPath of [path.join(homeDir, ".pi", "agent", "extensions"), path.join(cwd, ".pi", "extensions")]) {
        await collectExtensionFilesFromRoot(rootPath, extensionFiles)
    }

    for (const configuredPath of configuredPaths) {
        await collectExtensionFilesFromExplicitPath(configuredPath, extensionFiles)
    }

    return uniqueSorted([...extensionFiles].map(extensionNameFromPath))
}

async function discoverPackages(configuredSources) {
    return uniqueSorted(configuredSources)
}

async function discoverSkills(configuredPaths) {
    const skillFiles = new Set()
    const gitRoot = getGitRoot(cwd)
    const installedSkillSourceLabels = await loadInstalledSkillSourceLabels()

    await collectSkillFilesFromRoot(path.join(homeDir, ".pi", "agent", "skills"), skillFiles, {
        allowRootMdFiles: true,
    })
    await collectSkillFilesFromRoot(path.join(homeDir, ".agents", "skills"), skillFiles)
    await collectSkillFilesFromRoot(path.join(cwd, ".pi", "skills"), skillFiles, {
        allowRootMdFiles: true,
    })

    for (const dirPath of getAncestorDirs(cwd, gitRoot)) {
        await collectSkillFilesFromRoot(path.join(dirPath, ".agents", "skills"), skillFiles)
    }

    for (const configuredPath of configuredPaths) {
        await collectSkillFilesFromExplicitPath(configuredPath, skillFiles)
    }

    const skillNames = []
    const groupedSkillNames = new Map()
    for (const skillFilePath of skillFiles) {
        const skillName = await parseSkillName(skillFilePath)
        skillNames.push(skillName)

        const sourceLabel = inferSkillSourceLabel(skillFilePath, skillName, installedSkillSourceLabels)
        const sourceSkills = groupedSkillNames.get(sourceLabel) ?? []
        sourceSkills.push(skillName)
        groupedSkillNames.set(sourceLabel, sourceSkills)
    }

    return {
        names: uniqueSorted(skillNames),
        groups: [...groupedSkillNames.entries()]
            .map(([label, values]) => ({ label, values: uniqueSorted(values) }))
            .sort((left, right) => left.label.localeCompare(right.label)),
    }
}

async function main() {
    const configuredPaths = await loadConfiguredPaths()
    const [extensions, packages, skills] = await Promise.all([
        discoverExtensions(configuredPaths.extensionPaths),
        discoverPackages(configuredPaths.packageSources),
        discoverSkills(configuredPaths.skillPaths),
    ])

    emitHookMessage(
        [
            `Pi resources: ${extensions.length} extension${extensions.length === 1 ? "" : "s"}, ${packages.length} package${packages.length === 1 ? "" : "s"}, ${skills.names.length} skill${skills.names.length === 1 ? "" : "s"}`,
            formatIndentedSection("Extensions", extensions),
            formatIndentedSection("Packages", packages),
            formatGroupedSection("Skills", skills.groups),
        ].join("\n"),
        "info",
    )
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    emitHookMessage(`Pi resources: ${message}`, "info")
    console.error(message)
    process.exitCode = 1
})
