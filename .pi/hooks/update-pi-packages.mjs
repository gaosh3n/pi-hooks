#!/usr/bin/env node

import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const checkerPath = path.join(__dirname, "check-pi-package-updates.mjs")
const HOOK_NOTIFY_PREFIX = "PI_HOOK_NOTIFY:"

function notify(message, level = "info") {
    process.stderr.write(`${HOOK_NOTIFY_PREFIX}${JSON.stringify({ message, level })}\n`)
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? process.cwd(),
            env: options.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        })

        let stdout = ""
        let stderr = ""

        child.stdout.on("data", (chunk) => {
            stdout += String(chunk)
        })
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk)
        })
        child.on("error", reject)
        child.on("close", (code, signal) => {
            if (signal !== null) {
                reject(new Error(`${command} terminated by signal ${signal}`))
                return
            }
            resolve({ code: code ?? 0, stdout, stderr })
        })
    })
}

async function checkUpdates() {
    const result = await runCommand(process.execPath, [checkerPath])
    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `checker exited with code ${result.code}`)
    }

    try {
        return JSON.parse(result.stdout)
    } catch {
        throw new Error("checker did not return valid JSON")
    }
}

function formatUpdate(update) {
    return `${update.displayName} [${update.type}/${update.scope}] <- ${update.source}`
}

async function updatePiPackages() {
    const result = await runCommand("pi", ["update", "--extensions"])
    if (result.stdout.length > 0) {
        process.stderr.write(result.stdout)
    }
    if (result.stderr.length > 0) {
        process.stderr.write(result.stderr)
    }
    if (result.code !== 0) {
        throw new Error(`pi update --extensions exited with code ${result.code}`)
    }
}

async function main() {
    const before = await checkUpdates()
    if (!before.hasUpdates) {
        notify("Pi package updates: none available")
        return
    }

    notify(`Pi package updates: ${before.count} available`)
    for (const update of before.updates) {
        console.error(`- ${formatUpdate(update)}`)
    }

    notify("Pi package updates: running pi update --extensions")
    await updatePiPackages()

    const after = await checkUpdates()
    if (after.hasUpdates) {
        notify(`Pi package updates: ${after.count} still available after update`, "warning")
        for (const update of after.updates) {
            console.error(`- ${formatUpdate(update)}`)
        }
        process.exitCode = 1
        return
    }

    notify("Pi package updates: up to date")
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    notify(`Pi package updates: ${message}`, "warning")
    console.error(message)
    process.exitCode = 1
})
