#!/bin/sh
# Pi Hooks `tool_result` hook that runs `oxfmt` on files written either by
# direct edits (`edit`/`write`) or by bash commands detected via redirects/`tee`.
#
# stdin: Pi Hooks envelope.
#   - .payload.toolName          -> "edit" | "write" | "bash"
#   - .payload.input.path        -> file edited/written by `edit`/`write`
#   - .payload.input.command     -> bash command string for `bash`
#   - .sourcePath                -> <repo>/.pi/hooks.json
# stdout: nothing (formatting is a pure in-place side effect).
set -uf

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.payload.toolName // empty')
[ -n "$TOOL" ] || exit 0

SRC=$(printf '%s' "$INPUT" | jq -r '.sourcePath // empty')
REPO=$(cd "$(dirname "$SRC")/.." 2>/dev/null && pwd)
[ -n "$REPO" ] && cd "$REPO" 2>/dev/null || true

format_path() {
    pnpm oxfmt --write "$1" >/dev/null 2>&1 || true
}

case "$TOOL" in
    edit|write)
        PATH_=$(printf '%s' "$INPUT" | jq -r '.payload.input.path // empty')
        [ -n "$PATH_" ] || exit 0
        format_path "$PATH_"
        ;;
    bash)
        CMD=$(printf '%s' "$INPUT" | jq -r '.payload.input.command // empty')
        [ -n "$CMD" ] || exit 0

        TARGETS=$(
            printf '%s\n' "$CMD" \
                | grep -oE '(>>?)[[:space:]]*[^&|;<>() ]+|tee -a[[:space:]]*[^&|;<>() ]+|tee[[:space:]]*[^&|;<>() ]+' \
                | sed -E 's/^(>>?|tee -a|tee)[[:space:]]*//' \
                | sed -E "s/^['\"]//; s/['\"]$//" \
                | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$' || true
        )
        [ -n "$TARGETS" ] || exit 0

        printf '%s\n' "$TARGETS" | while IFS= read -r target; do
            [ -n "$target" ] || continue
            format_path "$target"
        done
        ;;
    *)
        exit 0
        ;;
esac

exit 0
