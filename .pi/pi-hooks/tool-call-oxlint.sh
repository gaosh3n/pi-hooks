#!/bin/sh
# Pi Hooks `tool_call` hook that lint-checks proposed `write` content before
# the tool executes. On lint failure, emits a blocking tool_call result so the
# model must revise and retry before any file is written.
set -uf

INPUT=$(cat)
PATH_=$(printf '%s' "$INPUT" | jq -r '.payload.input.path // empty')
CONTENT=$(printf '%s' "$INPUT" | jq -r '.payload.input.content // empty')
[ -n "$PATH_" ] || exit 0

case "$PATH_" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts) ;;
    *) exit 0 ;;
esac

SRC=$(printf '%s' "$INPUT" | jq -r '.sourcePath // empty')
REPO=$(cd "$(dirname "$SRC")/.." 2>/dev/null && pwd)
[ -n "$REPO" ] && cd "$REPO" 2>/dev/null || true

TMP=$(mktemp "/tmp/pi-hooks-oxlint-XXXXXX.${PATH_##*.}")
cleanup() {
    rm -f "$TMP"
}
trap cleanup EXIT INT TERM

printf '%s' "$CONTENT" > "$TMP"
OUT=$(pnpm oxlint --deny-warnings "$TMP" 2>&1)
RC=$?
[ "$RC" -eq 0 ] && exit 0

OUT=$(printf '%s' "$OUT" | sed "s|$TMP|$PATH_|g")
MSG=$(printf 'oxlint blocked the proposed write to %s. Fix the lint errors and try again:\n\n%s' "$PATH_" "$OUT")

jq -nc --arg reason "$MSG" '{version:1,event:"tool_call",output:{block:{reason:$reason}}}'
