# Codex hooks findings

This note consolidates the former `codex-hooks-merge.showboat.md` research into one place.

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

## Discovery / merge order

Codex discovers hooks in `discover_handlers()`:

- processes config layers in `LowestPrecedenceFirst` order
- remembers visited hook folders in `visited_json_hook_folders`
- loads `hooks.json` at most once per folder
- loads TOML hooks from the layer separately
- appends both sources into one discovered handler stream

Key source excerpt:

```rust
for layer in config_layer_stack.get_layers(
    ConfigLayerStackOrdering::LowestPrecedenceFirst,
    /*include_disabled*/ false,
) {
    let json_hooks = match layer.hooks_config_folder() {
        Some(config_folder) if visited_json_hook_folders.insert(config_folder.clone()) => {
            load_hooks_json(Some(config_folder.as_path()), &mut warnings)
        }
        _ => None,
    };
    let toml_hooks = load_toml_hooks_from_layer(layer, &mut warnings);

    for (source_path, hook_events) in [json_hooks, toml_hooks].into_iter().flatten() {
        append_hook_events(/* ... */);
    }
}
```

## `hooks.json` loading

Codex loads `hooks.json` as a strict JSON file, parses it into `HooksFile`, and returns only the `hooks` payload.

```rust
fn load_hooks_json(
    config_folder: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Option<(AbsolutePathBuf, HookEventsToml)> {
    let source_path = config_folder?.join("hooks.json");
    if !source_path.as_path().is_file() {
        return None;
    }

    let contents = fs::read_to_string(source_path.as_path()).ok()?;
    let parsed: HooksFile = serde_json::from_str(&contents).ok()?;
    (!parsed.hooks.is_empty()).then_some((source_path, parsed.hooks))
}
```

## Post-discovery normalization

Codex does not execute raw JSON objects directly. It normalizes each handler into in-memory records while preserving source order.

Normalization happens in `append_matcher_groups()`:

- iterate events in fixed event order
- iterate matcher groups in file order
- iterate handlers in group order
- normalize command fields
- compute a stable positional key
- compute display order
- append a list entry for inspection
- append an executable handler for runtime

```rust
let normalized_handler = HookHandlerConfig::Command {
    command: command.clone(),
    command_windows: None,
    timeout_sec: Some(timeout_sec),
    r#async,
    status_message: status_message.clone(),
};
let key = crate::hook_key(&source.key_source, event_name, group_index, handler_index);

hook_entries.push(HookListEntry { /* ... */ });
handlers.push(ConfiguredHandler {
    event_name,
    matcher: matcher.map(ToOwned::to_owned),
    command,
    timeout_sec,
    status_message,
    source_path: source.path.clone(),
    source: source.source,
    display_order: *display_order,
    env: source.env.clone(),
});
```

Loader-time filtering / normalization includes:

- `commandWindows` overrides `command` on Windows
- unsupported async hooks are skipped
- empty commands are skipped
- timeout is normalized
- env placeholders are substituted
- matcher validity is checked before appending

Codex also creates a parallel inspection record, `HookListEntry`, so the system can list discovered hooks separately from the subset that will actually execute.

## Runtime boundary

`ClaudeHooksEngine::new()` calls discovery once and stores the normalized handlers in memory:

```rust
let discovered = discovery::discover_handlers(
    config_layer_stack,
    plugin_hook_sources,
    plugin_hook_load_warnings,
    bypass_hook_trust,
);
Self {
    handlers: discovered.handlers,
    warnings: discovered.warnings,
    shell,
    output_spiller: HookOutputSpiller::new(),
}
```

After that, runtime selection is separate:

- `select_handlers()` filters the in-memory registry by event name + matcher
- `execute_handlers()` runs selected handlers
- results are returned in configured order even if execution completes out of order

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

## Codex matcher-pattern semantics

Codex's matcher logic lives in `<root-directory>/codex-rs/hooks/src/events/common.rs`.

Two helpers matter:

- `validate_matcher_pattern(matcher)`
- `matches_matcher(matcher, input)`

The behavior is:

- omitted matcher (`None`) => match all
- `""` => match all
- `"*"` => match all
- exact matchers are matched by string equality, not regex substring matching
- `|` inside an exact matcher means exact alternatives, e.g. `Edit|Write`
- only patterns that are not match-all and not exact are compiled as regex

Key source excerpt:

```rust
pub(crate) fn validate_matcher_pattern(matcher: &str) -> Result<(), regex::Error> {
    if is_match_all_matcher(matcher) || is_exact_matcher(matcher) {
        return Ok(());
    }
    regex::Regex::new(matcher).map(|_| ())
}

pub(crate) fn matches_matcher(matcher: Option<&str>, input: Option<&str>) -> bool {
    match matcher {
        None => true,
        Some(matcher) if is_match_all_matcher(matcher) => true,
        Some(matcher) if is_exact_matcher(matcher) => input
            .map(|input| matcher.split('|').any(|candidate| candidate == input))
            .unwrap_or(false),
        Some(matcher) => input
            .and_then(|input| regex::Regex::new(matcher).ok().map(|regex| regex.is_match(input)))
            .unwrap_or(false),
    }
}
```

Important implication: Codex does **not** treat every matcher as regex. It has a three-way classification:

1. match-all
2. exact literal / exact alternatives
3. regex

This is why `Bash` matches only `Bash`, while `Edit|Write` matches either exact tool name, and `^Bash(Output)?$` is treated as regex.

## Codex matcher coverage by event

Codex also makes matcher coverage event-specific via `matcher_pattern_for_event(event_name, matcher)`.

- matcher-capable events include `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, and `PostCompact`
- `UserPromptSubmit` and `Stop` ignore matchers entirely and force `None`

So Codex has two separate questions:

1. does this event even use a matcher?
2. if it does, is the matcher match-all, exact, or regex?

## Codex tool coverage for literal matchers

For tool-related events, Codex literal matcher examples in docs often use built-in tool names like `Bash`, `Edit`, and `Write`, but the source/tests show that the exact-matcher path is not limited to only those names.

For example, `common.rs` tests exact matching for an MCP tool name:

```rust
assert!(matches_matcher(
    Some("mcp__memory__create_entities"),
    Some("mcp__memory__create_entities")
));
assert!(!matches_matcher(
    Some("mcp__memory"),
    Some("mcp__memory__create_entities")
));
```

That means the Codex rule is really syntax-based exact matching, not "only a fixed enum of built-in tools." Built-in tool names are just the easiest examples to document.

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

## Codex runtime call sites

Codex has a separate runtime host in `<root-directory>/codex-rs/core/src/hook_runtime.rs`, and the rest of the app calls into it at specific lifecycle seams.

Concrete call sites:

- turn start in `core/src/session/turn.rs`
    - `run_pending_session_start_hooks()`
- before input is recorded in `core/src/session/turn.rs`
    - `inspect_pending_input()` via `run_hooks_and_record_inputs()`
- after the model finishes a turn in `core/src/session/turn.rs`
    - `run_turn_stop_hooks()`
- before tool execution in `core/src/tools/registry.rs`
    - `run_pre_tool_use_hooks()`
- after successful tool execution in `core/src/tools/registry.rs`
    - `run_post_tool_use_hooks()`
- approval paths in:
    - `core/src/tools/approvals.rs`
    - `core/src/tools/network_approval.rs`
    - `core/src/mcp_tool_call.rs`
    - all call `run_permission_request_hooks()`
- teardown in `core/src/session/handlers.rs`
    - `run_session_end_hooks()`

`hook_runtime.rs` exposes the main runtime entry points:

- `run_pending_session_start_hooks`
- `run_pre_tool_use_hooks`
- `run_permission_request_hooks`
- `run_post_tool_use_hooks`
- `run_turn_stop_hooks`
- `run_session_end_hooks`
- `run_pre_compact_hooks`
- `run_post_compact_hooks`

## Codex event selection and hook input/output

Additional sources inspected for this supplement:

- `<root-directory>/codex-rs/hooks/src/engine/dispatcher.rs`
- `<root-directory>/codex-rs/hooks/src/engine/output_parser.rs`
- `<root-directory>/codex-rs/hooks/src/engine/command_runner_tests.rs`
- `<root-directory>/codex-rs/hooks/src/schema.rs`
- `<root-directory>/codex-rs/core/src/hook_runtime.rs`

### Runtime selection stays separate from discovery

After discovery builds the in-memory handler list, Codex does a second explicit selection step per fired event.

`select_handlers()` / `select_handlers_for_matcher_inputs()` in `dispatcher.rs`:

- filter first by event name
- then filter by matcher only for matcher-capable events
- force match-all behavior for `UserPromptSubmit` and `Stop`
- accept multiple matcher inputs for a single fired event when Codex has compatibility aliases
- still run each configured handler at most once even if several matcher inputs match

Key source excerpt:

```rust
handlers
    .iter()
    .filter(|handler| handler.event_name == event_name)
    .filter(|handler| match event_name {
        HookEventName::PreToolUse
        | HookEventName::PermissionRequest
        | HookEventName::PostToolUse
        | HookEventName::SessionStart
        | HookEventName::SessionEnd
        | HookEventName::SubagentStart
        | HookEventName::SubagentStop
        | HookEventName::PreCompact
        | HookEventName::PostCompact => {
            if matcher_inputs.is_empty() {
                matches_matcher(handler.matcher.as_deref(), /*input*/ None)
            } else {
                matcher_inputs
                    .iter()
                    .any(|input| matches_matcher(handler.matcher.as_deref(), Some(input)))
            }
        }
        HookEventName::UserPromptSubmit | HookEventName::Stop => true,
    })
    .cloned()
    .collect()
```

Important implication: Codex keeps the registry normalized once, then computes event-specific selection from that registry without re-reading config files.

### Command stdin is event-specific structured JSON

Codex does not use one generic `{ event, payload }` wire shape for command-hook stdin. Instead, it defines per-event input structs and generated JSON Schemas.

Examples from `schema.rs`:

- `PreToolUseCommandInput` includes `session_id`, `turn_id`, optional subagent metadata, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `tool_name`, `tool_input`, and `tool_use_id`
- `SessionStartCommandInput` includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, and `source`
- `UserPromptSubmitCommandInput` includes `prompt` rather than a generic payload blob

So Codex's protocol is explicitly event-shaped, not merely event-tagged.

### Command stdout is also event-specific and is the control channel

Codex treats stdout as machine-readable JSON and parses it with event-specific output parsers.

Key points from `output_parser.rs` and `schema.rs`:

- stdout is parsed into event-specific output wire structs such as `SessionStartCommandOutputWire`, `PreToolUseCommandOutputWire`, and `UserPromptSubmitCommandOutputWire`
- output schemas use `deny_unknown_fields`, so the structured contract is intentionally narrow
- there is a shared universal output section with fields like:
    - `continue`
    - `stopReason`
    - `suppressOutput`
    - `systemMessage`
- event-specific output sections add capabilities such as:
    - `additional_context`
    - block decisions + reasons
    - permission decisions
    - updated tool input

This means Codex has a deliberate bidirectional protocol: stdin carries structured event data in, stdout carries structured control data back out.

### Event powers are asymmetric, not one global hook capability set

Codex does not grant the same output powers to every event.

Examples:

- `SessionStart` can add context
- `UserPromptSubmit` can block and add context
- `PreToolUse` can block, influence permission behavior, add context, and sometimes update tool input
- `Stop` can block
- stateless observation-style events have much smaller output shapes

Important implication: Codex's output protocol is event-specific policy, not a uniform "all hooks may mutate the world" rule.

### Execution is concurrent, but result order is normalized

`execute_handlers()` launches selected handlers concurrently with `FuturesUnordered`, but then sorts completed results back into configured order before returning them.

So Codex splits:

- wall-clock completion order
- configured declaration order

This is a useful design point for any future hook protocol that wants concurrency without nondeterministic aggregate behavior.

### Runtime interpretation is explicit in host call sites

Codex's host runtime does not just collect parsed hook outputs; it applies them at specific seams.

Examples from `hook_runtime.rs`:

- `run_pending_session_start_hooks()` records additional context returned by start hooks
- `run_pre_tool_use_hooks()` can block a tool call or continue with updated input
- stop-turn hooks resolve different runtime outcomes from their parsed outputs

So the structured stdout protocol only matters because the host has explicit per-event code that consumes it.

### Output parsing is strict, but unsupported semantics are still interpreted per event

Additional details from `schema.rs` and `output_parser.rs`:

- output wire structs use `deny_unknown_fields`, so unknown JSON fields are rejected at parse time
- Codex still performs a second semantic validation pass after JSON parsing
- that semantic pass rejects event-forbidden fields such as unsupported universal controls or malformed block decisions on specific events
- invalid output is contained at the hook boundary rather than silently reinterpreted into some other effect

This is a useful Pi Hooks reference point: syntax validation and event-policy validation are separate concerns, even when both happen on stdout.

## Codex operational loop: how hook execution is surfaced and managed

Additional sources inspected for this section:

- `https://developers.openai.com/codex/hooks`
- `<root-directory>/codex-rs/hooks/src/engine/dispatcher.rs`
- `<root-directory>/codex-rs/hooks/src/engine/output_parser.rs`
- `<root-directory>/codex-rs/hooks/src/events/session_start.rs`
- `<root-directory>/codex-rs/hooks/src/events/pre_tool_use.rs`
- `<root-directory>/codex-rs/hooks/src/events/post_tool_use.rs`
- `<root-directory>/codex-rs/hooks/src/events/stop.rs`
- `<root-directory>/codex-rs/core/src/hook_runtime.rs`

### Codex models hook execution as first-class runtime data

Codex does not treat hook subprocesses as invisible implementation details. The runtime and protocol exchange structured hook run records with lifecycle events.

`hook_runtime.rs` imports and emits:

- `HookStartedEvent`
- `HookCompletedEvent`
- `HookRunStatus`

The runtime sends those through the session event stream at each hook seam via helpers such as:

- `emit_hook_started_events(...)`
- `emit_hook_completed_events(...)`

The status enum used by completed runs is:

- `running`
- `completed`
- `failed`
- `blocked`
- `stopped`

Important implication: Codex has a dedicated operational plane for hooks, separate from stderr text or semantic host effects.

### Codex previews hook runs before execution

Before the runtime actually executes selected hooks, it computes preview runs and emits started events for them.

Examples in `hook_runtime.rs`:

- `run_pre_tool_use_hooks()` calls `hooks.preview_pre_tool_use(...)` then `emit_hook_started_events(...)`
- `run_pending_session_start_hooks()` uses `run_context_injecting_hook(...)`, which also emits preview-based started events
- `run_turn_stop_hooks()` calls `hooks.preview_stop(...)` before execution

This gives the TUI/protocol deterministic metadata for “which hooks are now running” before completion results exist.

### Each run summary carries config and display metadata

`dispatcher.rs` builds run summaries that include more than success/failure state. The preview/completed summaries carry fields such as:

- event name
- handler type
- execution mode
- scope/source layer
- source path
- configured display order
- final status
- optional `status_message`

This aligns with the public docs, which present `statusMessage` as a config field on handlers, not as subprocess stdout.

Important implication: user-facing progress labels come from trusted config, while stdout remains the machine-readable hook control channel.

### Codex executes concurrently, then normalizes completion order

`dispatcher.rs` uses `FuturesUnordered` to execute selected hooks concurrently, but then sorts the results back into configured order with `completed.sort_by_key(...)` before host interpretation.

So Codex deliberately separates:

- wall-clock completion order
- semantic/reporting order

That is a strong reference point for Pi Hooks because issues `#16`-`#22` already require deterministic configured-order semantic composition.

### Completion entries are typed, not just free-form warnings

The event-specific parsers (`session_start.rs`, `pre_tool_use.rs`, `post_tool_use.rs`, `stop.rs`) accumulate `HookOutputEntry` values describing what happened during a hook run.

From those files we can see Codex records entry text for things like:

- runtime/process errors
- surfaced `systemMessage`
- stop reasons
- block/feedback reasons
- extra context accepted from hook output

The result is that a hook run has both:

- a coarse final status (`completed` / `failed` / `blocked` / `stopped`)
- a fine-grained typed entry log explaining why

### Semantic effects and reporting are intentionally separate

Codex hook output parsing does not collapse “what happened operationally” into “what effect the hook had on host state.”

Examples:

- `PreToolUse` can yield `updated_input`, but the run still separately records status and entries
- `SessionStart` and related events can contribute `additionalContext`, while the run record still carries its own completion event
- `systemMessage` is surfaced as a visible entry rather than silently discarded
- invalid or unsupported output marks the run as failed and reports the reason, while the host often continues fail-open for that seam

This separation is the main operational-loop lesson for Pi Hooks: stdout semantics and run reporting should not be the same thing.

### `statusMessage` is part of the operator experience

The public Codex hooks docs show `statusMessage` examples such as:

- `Loading session notes`
- `Checking Bash command`
- `Reviewing Bash output`

The same field is present in Codex config/runtime structures (`hook_config.rs`, `dispatcher.rs`).

So Codex has an explicit concept of operator-visible per-hook progress text. It is not inferred from stderr, and it is not coupled to semantic JSON output.

### Hook events also feed telemetry/metrics

`hook_runtime.rs` does more than notify the TUI/protocol. Completed events also feed:

- duration metrics via `emit_hook_completed_metrics(...)`
- analytics via `track_hook_completed_analytics(...)`

Those payloads include status/source information derived from the same hook run summaries.

Important implication: one structured run model powers UI, debugging, and analytics.

### Codex’s operational loop is richer than its semantic loop

Taken together, Codex’s design is:

- preview selected hooks
- emit started events
- execute hooks
- classify outcomes into structured statuses
- attach typed output entries
- emit completed events
- separately apply host-side semantic effects
- separately record metrics/analytics

For Pi Hooks, the key lesson is not “copy Codex’s exact stdout fields.” The deeper lesson is that hooks are treated as a first-class observable runtime, not just subprocesses that occasionally mutate host state.

---

# Codex research — hook-run classification (#25 blockers)

Asset for `docs/decision-maps/pi-hooks-hook-run-classification.md`. Source: Codex `codex-rs`
(`hooks/src/engine/{command_runner,dispatcher,output_parser}.rs`, `hooks/src/events/*.rs`,
`protocol/src/protocol.rs`). Findings only; Pi decisions live in the decision map.

## Runner: `command_runner.rs` (owns timing only)

`run_command` → `CommandRunResult { started_at, completed_at, duration_ms, exit_code, stdout, stderr, error }`. No `status`. Outcomes:
- spawn fail → `error=Some`, stdout empty, `outcome:"spawn_error"`
- stdin write fail → kill child, `error=Some("failed to write hook stdin: …")`, `outcome:"stdin_error"`
- wait error → `outcome:"wait_error"`
- **timeout → stdout DISCARDED (empty), `error=Some("hook timed out after Ns")`, `outcome:"timeout"`**
- exit 0 → stdout preserved, `outcome:"completed"`

**No abort/shutdown cancellation path exists in Codex's runner.** Only timeout.

## Dispatcher: `dispatcher.rs` (owns status + entries, built AFTER runner returns)

- `running_summary(handler)` → status `Running`, `completed_at=None`, entries empty (in flight).
- `completed_summary(handler, run_result, status, entries)` → status∈{Completed,Failed,Blocked,Stopped}, `completed_at=Some`, `duration_ms=Some`, entries filled.
- Dispatcher builds the completed summary **after** `run_command` returns. Runner owns timing; dispatcher owns status+entries. This is the "option (a)" split.

## Protocol model: `protocol.rs`

- `HookRunStatus = Running | Completed | Failed | Blocked | Stopped` (5).
- `HookOutputEntryKind = Warning | Stop | Feedback | Context | Error` (5).
- `HookOutputEntry { kind, text }`. `HookRunSummary` carries id/event/scope/source/display_order/status/status_message/started_at/completed_at/duration_ms/entries.

## Status assignment (event handlers, e.g. `session_start.rs:222-320`, `post_tool_use.rs:169-250`, `pre_tool_use.rs:196-270`, `user_prompt_submit.rs:141-190`)

Uniform pattern across events:
- `error` set (spawn/stdin/wait/**timeout**) → `Failed` + `Error` entry(text=error).
- exit 0 + empty stdout → `Completed` (no entries).
- exit 0 + valid JSON parse → `Completed` + entries from parsed fields (`Warning`=systemMessage, `Context`/`Feedback`=additionalContext). `continue:false` (SessionStart only) → `Stopped` + `Stop` entry(stopReason) + stop_reason propagated to outcome.
- exit 0 + **looks-like-JSON but parse fails** → `Failed` + `Error` entry("hook returned invalid <event> JSON output"). **Invalid semantic stdout collapses to `Failed`, not a separate status.**
- exit 0 + non-JSON stdout → `Completed` + `Context` entry(plain stdout as context).
- nonzero exit → `Failed` + `Error` entry("hook exited with code N").
- no exit code → `Failed` + `Error` entry("hook exited without a status code").

Terminal-intent specifics:
- PostToolUse `decision:block` + non-empty reason → `Blocked` + `Feedback` entry(reason) + reason fed to model.
- PreToolUse `decision:block`/`permissionDecision:deny` + non-empty reason → `Blocked`; block_reason pushed as entry. stderr-only block (exit 2 + stderr reason) also → `Blocked`.
- UserPromptSubmit `decision:block` → `Blocked`. `continue:false` (with stopReason) → `Stopped` + `Stop` entry.
- SessionStart `continue:false` → `Stopped`; `additionalContext` injection → `Completed` + `Context`.
- Serialization failure before run → `Failed` + `Error` entry, duration_ms=0 (`common.rs:65`).

**Interruption wins structurally:** timeout discards stdout, so the dispatcher never sees an envelope → `Blocked`/`Stopped` are unobservable on a timed-out run (a valid block envelope written before timeout is lost). Timeout is always `Failed`.

## Retention: emit-and-drop (Codex) — the Pi divergence crux

`HookCompletedEvent` is emitted as a protocol event and **not retained** in any session-scoped
store. Confirmed: `rg HookCompletedEvent` hits only `hooks/src/events/*` (producers) and
`engine/dispatcher.rs`; no `retain|history|push` buffer in `core/src/session`. Codex can emit-and-drop because it has an outbound protocol event channel. **Pi is a TypeScript extension with no
outbound protocol event** → the only observable channel for a finalized classification is a
session-scoped store. This forces Pi to retain where Codex emits.

## Notifications: `legacy_notify.rs` — reverse direction, no failure surfacing

`legacy_notify.rs` builds an `AgentTurnComplete` payload **appended to a user's configured notify
hook argv** — i.e. the **host calling a user hook** (host → user-hook), NOT the host surfacing
hook failures to the user. There is **no in-Codex mechanism that proactively notifies the user of
hook failures**. Failures surface only as `Error`-kind `HookOutputEntry` in emitted
`HookCompletedEvent` (consumed by the TUI/CLI, which gates display). **No repetition threshold, no
seam-importance gate** in Codex — every `Failed` run emits its `Error` entry and the surface
decides what to show.

## Implications for Pi (decisions applied in the decision map, not here)

1. Runner-owns-timing + dispatcher-owns-status+entries is the validated split → Pi "option (a)".
2. 5-status taxonomy confirmed viable; Pi renames `Stopped`→`handled` (Pi `input` handled) and maps `before_agent_start` shaping → `completed` (no stop semantics in Pi).
3. Invalid-semantic-stdout collapses to `failed`+`error` (entry text identifies it) — keeps taxonomy at 5 and gives #3 a countable signal.
4. Timeout→`failed`; interruption wins; `shutdown`/`abort`→`failed` with distinct reason (shutdown silenced at notification layer).
5. Pi must retain session-scoped where Codex emits (extension has no protocol event).
6. Codex emits-all-errors + surface-gates; Pi #6's "repeated/important-seams" nuance is a NOTIFICATION-layer gate, not a classification-layer suppression — record all, gate later.