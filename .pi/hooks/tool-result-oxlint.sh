#!/bin/sh
# Pi Hooks `tool_result` hook that runs `oxlint` on files written either by
# direct edits (`edit`/`write`) or by bash commands detected via redirects/`tee`.
#
# stdin: Pi Hooks envelope.
#   - .payload.toolName          -> "edit" | "write" | "bash"
#   - .payload.input.path        -> file edited/written by `edit`/`write`
#   - .payload.input.command     -> bash command string for `bash`
#   - .sourcePath                -> <repo>/.pi/hooks.json
# stdout: nothing on success. On lint failure, emits a structured tool_result
# error so the model must fix the lint issue before proceeding.
set -uf

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.payload.toolName // empty')
[ -n "$TOOL" ] || exit 0

SRC=$(printf '%s' "$INPUT" | jq -r '.sourcePath // empty')
REPO=$(cd "$(dirname "$SRC")/.." 2>/dev/null && pwd)
[ -n "$REPO" ] && cd "$REPO" 2>/dev/null || true

emit_error() {
    jq -nc --arg text "$1" \
        '{version:1,event:"tool_result",output:{isError:true,content:[{type:"text",text:$text}]}}'
}

case "$TOOL" in
    edit|write)
        PATH_=$(printf '%s' "$INPUT" | jq -r '.payload.input.path // empty')
        [ -n "$PATH_" ] || exit 0

        OUT=$(pnpm oxlint --deny-warnings "$PATH_" 2>&1)
        RC=$?

        if [ "$RC" -ne 0 ]; then
            emit_error "$(printf 'oxlint reported errors in %s (fix and re-apply your edit):\n\n%s' "$PATH_" "$OUT")"
        fi
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

        OUT=$(printf '%s\n' "$TARGETS" | xargs pnpm oxlint --deny-warnings 2>&1)
        RC=$?

        if [ "$RC" -ne 0 ]; then
            emit_error "$(printf 'oxlint reported errors in file(s) you wrote via a shell redirect (%s):\n\n%s\n\nFix the lint errors and re-apply your bash command.' "$TARGETS" "$OUT" | tr '\n' ' ')"
        fi
        ;;
    *)
        exit 0
        ;;
esac

exit 0
