#!/bin/sh
# Pi Hooks `tool_call` hook that formats proposed `write` content before the
# tool executes. On success, emits a patched tool_call input only when oxfmt
# changes the proposed content.
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

TMP=$(mktemp "/tmp/pi-hooks-oxfmt-XXXXXX.${PATH_##*.}")
cleanup() {
    rm -f "$TMP"
}
trap cleanup EXIT INT TERM

printf '%s' "$CONTENT" > "$TMP"
pnpm oxfmt --write "$TMP" >/dev/null 2>&1 || exit 0
FORMATTED=$(cat "$TMP")
[ "$FORMATTED" = "$CONTENT" ] && exit 0

printf '%s' "$INPUT" \
    | jq -c --arg content "$FORMATTED" '{version:1,event:"tool_call",output:{input:(.payload.input + {content:$content})}}'
