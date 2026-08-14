#!/bin/sh
# Pi Hooks `agent_settled` hook that rings Ghostty's terminal bell so macOS can
# bounce the Ghostty dock icon when the app is unfocused.
#
# Pi Hooks captures child stdout/stderr, so write BEL directly to the controlling
# terminal device instead of stdout.
set -u

[ "$(uname -s 2>/dev/null)" = "Darwin" ] || exit 0
[ "${TERM_PROGRAM:-}" = "ghostty" ] || exit 0

if [ -w /dev/tty ]; then
    printf '\a' > /dev/tty 2>/dev/null || true
    exit 0
fi

TTY_NAME=$(ps -o tty= -p "${PPID:-0}" 2>/dev/null | tr -d '[:space:]')
case "$TTY_NAME" in
    ""|"?") exit 0 ;;
esac

TTY_PATH="/dev/$TTY_NAME"
[ -w "$TTY_PATH" ] || exit 0
printf '\a' > "$TTY_PATH" 2>/dev/null || true
