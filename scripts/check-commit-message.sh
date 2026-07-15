#!/usr/bin/env bash
set -euo pipefail

message_file=${1:-}

if [[ -z "$message_file" ]]; then
  echo "Missing commit message file path" >&2
  exit 1
fi

if [[ ! -f "$message_file" ]]; then
  echo "Commit message file not found: $message_file" >&2
  exit 1
fi

message=$(tr -d '\r' < "$message_file")
message=${message%$'\n'}

if [[ -z "$message" ]]; then
  echo "Commit message cannot be empty" >&2
  exit 1
fi

if [[ "$message" == *$'\n'* ]]; then
  echo "Commit message must be a single line" >&2
  exit 1
fi

if (( ${#message} > 72 )); then
  echo "Commit message must be 72 characters or fewer" >&2
  exit 1
fi

if [[ "$message" =~ ^([a-z]+)(\(([^[:space:]()]+)\))?:[[:space:]](.+)[[:space:]]\(#([0-9]+)\)$ ]]; then
  type=${BASH_REMATCH[1]}
  scope=${BASH_REMATCH[3]:-}
  subject=${BASH_REMATCH[4]}
  issue=${BASH_REMATCH[5]}
elif [[ "$message" =~ ^([a-z]+)(\(([^[:space:]()]+)\))?:[[:space:]](.+)$ ]]; then
  type=${BASH_REMATCH[1]}
  scope=${BASH_REMATCH[3]:-}
  subject=${BASH_REMATCH[4]}
  issue=""
else
  echo 'Commit message must match "type[scope]: subject" or "type[scope]: subject (#ref)"' >&2
  exit 1
fi

case "$type" in
  build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test) ;;
  *)
    echo "Unsupported commit type: $type" >&2
    exit 1
    ;;
esac

if [[ -n "$scope" && -z "${scope// }" ]]; then
  echo "Commit scope cannot be empty" >&2
  exit 1
fi

if [[ -z "${subject// }" ]]; then
  echo "Commit subject cannot be empty" >&2
  exit 1
fi

if [[ -n "$issue" && ! "$issue" =~ ^[0-9]+$ ]]; then
  echo "Commit footer issue number must be numeric" >&2
  exit 1
fi
