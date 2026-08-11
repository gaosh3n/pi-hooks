#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

function inferHomebrewPiRoot() {
    const executable = process.env.PI_BIN ?? process.env.npm_execpath
    void executable

    const pathEntries = (process.env.PATH ?? "").split(path.delimiter)
    for (const entry of pathEntries) {
        if (entry.length === 0) {
            continue
        }

        const candidate = path.join(entry, process.platform === "win32" ? "pi.cmd" : "pi")
        if (!existsSync(candidate)) {
            continue
        }

        const realExecutable = realpathSync(candidate)
        const prefix = path.dirname(path.dirname(realExecutable))
        const homebrewRoot = path.join(prefix, "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent")
        if (existsSync(path.join(homebrewRoot, "dist", "core", "package-manager.js"))) {
            return homebrewRoot
        }
    }

    return undefined
}

async function inferLocalPackageRoot() {
    const entryUrl = await import.meta.resolve("@earendil-works/pi-coding-agent")
    const entryPath = realpathSync(new URL(entryUrl))
    return path.dirname(path.dirname(entryPath))
}

async function resolvePiRoot() {
    const homebrewRoot = inferHomebrewPiRoot()
    if (homebrewRoot !== undefined) {
        return homebrewRoot
    }

    return inferLocalPackageRoot()
}

async function importPiModules(piRoot) {
    const packageManagerUrl = pathToFileURL(path.join(piRoot, "dist", "core", "package-manager.js")).href
    const settingsManagerUrl = pathToFileURL(path.join(piRoot, "dist", "core", "settings-manager.js")).href
    const configUrl = pathToFileURL(path.join(piRoot, "dist", "config.js")).href

    const [{ DefaultPackageManager }, { SettingsManager }, { getAgentDir }] = await Promise.all([
        import(packageManagerUrl),
        import(settingsManagerUrl),
        import(configUrl),
    ])

    return { DefaultPackageManager, SettingsManager, getAgentDir }
}

async function getUpdateCheckResult() {
    const cwd = process.cwd()
    const piRoot = await resolvePiRoot()
    const { DefaultPackageManager, SettingsManager, getAgentDir } = await importPiModules(piRoot)
    const agentDir = getAgentDir()
    const settingsManager = SettingsManager.create(cwd, agentDir)
    const packageManager = new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager,
    })

    const updates = await packageManager.checkForAvailableUpdates()
    return {
        hasUpdates: updates.length > 0,
        count: updates.length,
        cwd,
        piRoot,
        updates,
    }
}

async function main() {
    if (process.argv.length > 2) {
        throw new Error("This script does not accept command-line arguments")
    }

    const result = await getUpdateCheckResult()
    console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
