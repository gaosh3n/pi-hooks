# Codex hooks findings for `pi-hooks`

## Sources inspected

`root-directory` represents the root directory of Codex source code.

- `<root-directory>/codex-rs/config/src/hook_config.rs`
- `<root-directory>/codex-rs/hooks/src/engine/discovery.rs`
- `<root-directory>/codex-rs/hooks/src/config_rules.rs`
- `<root-directory>/codex-rs/hooks/src/events/common.rs`
- `<root-directory>/codex-rs/hooks/src/events/pre_tool_use.rs`
- `<root-directory>/codex-rs/hooks/src/events/post_tool_use.rs`
- `<root-directory>/codex-rs/core/src/hook_runtime.rs`
- `<root-directory>/codex-rs/core/src/session/mod.rs`
- `<root-directory>/codex-rs/core/src/config/config_loader_tests.rs`
- Pi docs: `docs/extensions.md`

## What Codex validates

- `hooks.json` has strict top-level shape: optional `description`, required `hooks`, no root-level event keys.
- Event keys are fixed and currently use Codex event names like `PreToolUse`, `PostToolUse`, `SessionStart`.
- Handler variants in the data model are `command`, `prompt`, and `agent`, but runtime only executes `command`; `prompt` and `agent` are discovered then skipped with warnings.
- Empty commands are skipped with warnings.
- Unsupported async hooks are skipped with warnings; only `SessionEnd` has special async handling.
- Matchers are event-specific. Some events ignore matchers entirely.
- Matchers support:
    - omitted / `""` / `"*"` => match all
    - plain literals like `Bash`
    - pipe-separated exact alternatives like `Edit|Write`
    - full regex when regex metacharacters are present
- Invalid regexes are warned and skipped only for matcher-capable events.
- Timeouts are normalized at load time, not just schema time.

## How Codex loads hooks

- Hook discovery is gated by a feature flag.
- It reads `hooks.json` from the config folder associated with each config layer.
- User/global hooks live beside user `config.toml`.
- Project hooks live in project `.codex/` folders.
- Config layers are processed in **lowest-precedence-first** order.
- Handlers are **appended**, not deep-merged by key.
- Within a single config layer, if both `hooks.json` and TOML hook declarations exist, Codex warns and then loads both in this order:
    1. `hooks.json`
    2. TOML `hooks`
- If multiple config layers share the same hooks folder, `hooks.json` from that folder is loaded only once.
- Hook state (`enabled`, `trusted_hash`) is not stored in project files; effective state is read only from user/session config layers.

A concrete proof point is `core/tests/suite/hooks.rs::pre_tool_use_merges_hooks_json_and_config_toml()`, plus `hooks/src/engine/discovery.rs`, which shows the append order and the per-folder `visited_json_hook_folders` dedup.

## How Codex turns discovered hooks into runtime handlers

After discovery, Codex performs a normalization pass before runtime dispatch:

- `load_hooks_json()` reads and parses `hooks.json` into `HooksFile`, then extracts `HookEventsToml`
- `append_hook_events()` iterates event buckets
- `append_matcher_groups()` walks matcher groups in file order and handlers in group order
- each command hook is normalized into in-memory metadata, not executed directly from raw parsed JSON

The key normalized runtime record is `ConfiguredHandler`, which stores:

- event name
- matcher string
- command string
- normalized timeout
- status message
- source path / source kind
- display order
- env substitutions

Loader-time normalization / filtering includes:

- choose `commandWindows` on Windows
- reject unsupported async hooks
- reject empty commands
- normalize timeouts
- validate matcher strings
- substitute source-provided env vars into commands

Codex also creates a parallel inspection record, `HookListEntry`, so the system can list discovered hooks separately from the subset that will actually execute.

Then `ClaudeHooksEngine::new()` stores the discovered `ConfiguredHandler` list in memory once. Runtime execution is a separate phase:

- `select_handlers()` filters by event name + matcher
- `execute_handlers()` runs the selected handlers
- results are returned in configured order even if command completion order differs

## How Codex activates hooks

- Discovery/listing and runtime activation are separate steps.
- Listed hooks carry metadata: source, enabled, managed, hash, trust status.
- Managed hooks are always trusted.
- User/project/plugin hooks run only when:
    - the hooks feature is enabled,
    - the hook is enabled,
    - and either trusted hash matches or bypass-trust is active.
- Startup warnings are surfaced for malformed files and dangerous bypass mode.
- Session startup builds a hook registry once from config + plugins.
- Core runtime calls preview/run methods at concrete lifecycle points (`SessionStart`, `PreToolUse`, `PostToolUse`, etc.).

## Codex command I/O contract

Codex command hooks are not just fire-and-forget shell commands.

They receive structured JSON on stdin and can return structured JSON on stdout.
This enables hooks to:

- block execution
- rewrite tool input (`PreToolUse.updatedInput`)
- add context for the model
- emit feedback / stop reasons

For Pi, this is the key design decision: if `hooks.json` is meant to be “similar to Codex”, command hooks should use a structured stdin/stdout protocol rather than relying only on exit codes.

## Recommended Pi v1 adaptation

### Validation

- Keep `hooks.json` strict and JSON-only.
- Reject unknown event names and unknown handler fields.
- Support only `type: "command"` in v1; reject other handler types instead of silently skipping them.
- Move cross-field checks into the loader:
    - command must be non-empty
    - timeout normalized to default `600`, min `1`
    - matcher compiled only for events with documented matcher input
- Define matcher semantics exactly like Codex: `None|""|"*"`, exact literals, `|` alternatives, regex fallback.

### Loading

- Load global hooks from `~/.pi/hooks.json`.
- Load project hooks from ancestor `.pi/hooks.json` files in root-to-leaf order.
- Append all discovered handlers in deterministic order; do not deep-merge by key.
- Deduplicate only by exact file path so the same file is not loaded twice.
- Keep trust/activation separate from loading; Pi does not natively provide a trust layer.

### Activation

- Implement `pi-hooks` as a normal Pi extension that reads configs and registers `pi.on(...)` handlers.
- Pi has no native trust gate, so `pi-hooks` must not assume a built-in `project_trust` policy.
- Global vs project-local scope comes from discovery order, not from Pi core trust state.
- If later we want selective activation, it should be an explicit `pi-hooks` policy, not a dependency on Pi core trust.
- Command hooks should receive event JSON on stdin and return JSON on stdout.
- The first release should support two hook behaviors:
    - passive side effects on any event
    - blocking / mutation only on events whose Pi extension API already supports it (`tool_call`, `tool_result`, `before_agent_start`, `context`, etc.)
- Event-specific adapters should be explicit rather than generic magic.

## Recommended initial scope

Start with:

- `project_trust`
- `session_start`
- `before_agent_start`
- `tool_call`
- `tool_result`
- `tool_execution_end`
- `session_shutdown`

That subset covers the most useful Codex-like workflows without needing every Pi event at once.
