# Pi Hooks: operational loop and hook-run observability

Related assets:

- `docs/research/codex-hooks-findings.md`
- `docs/research/codex-hooks-operational-loop.md`
- `docs/research/pi-extension-operational-surface.md`
- `docs/decision-maps/pi-hooks-runtime.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## #1: Should this planning effort stay Pi-native or copy Codex’s protocol whole-cloth?

Blocked by: none
Type: Discuss

### Question

When we add hook-run observability, should Pi Hooks imitate Codex’s exact event vocabulary and stdout powers, or keep Pi-native semantics and borrow only the operational shape?

### Answer

Resolved.

Stay Pi-native.

Pi Hooks should keep the semantic/event decisions already made through issues `#1`, `#6`, `#16`, and children `#17`-`#22`. Codex is reference material for the operational loop, not the vocabulary to clone. The most reusable Codex idea is the first-class hook-run model: preview, start, complete, classify, inspect.

## #2: Do we need a separate decision map for the operational loop?

Blocked by: #1
Type: Discuss

### Question

Is the hook operational loop now a distinct multi-session planning effort, or can it be folded into the already-resolved runtime/stdio map?

### Answer

Resolved.

Yes, it is a distinct planning effort.

`docs/decision-maps/pi-hooks-runtime.md` resolved the command-hook runtime seam and semantic stdout contract. The next problem is different: how Pi Hooks reports, tracks, and exposes hook execution to the user/TUI. That has enough fog of war to justify a separate map.

## #3: What internal hook-run record should Pi Hooks adopt?

Blocked by: #1, #2
Type: Discuss

### Question

What is the minimum internal runtime object that can represent one selected hook run across awaited semantic hooks and fire-and-forget observe-only hooks?

### Answer

Resolved.

Adopt one session-scoped `HookRunRecord` per selected hook. This should become the deep module boundary for all later UI/protocol work.

Minimum shape:

- identity
  - `id`
  - `eventName`
  - `sourcePath`
  - normalized `matcher`
  - `command`
  - `displayOrder`
  - optional config `statusMessage`
- lifecycle
  - `startedAt`
  - `completedAt?`
  - derived `durationMs?`
- status
  - `running`
  - `completed`
  - `failed`
  - `blocked`
  - `stopped`
- entries
  - typed `entries[]` owned by Pi Hooks, not by raw stdout
  - minimum entry kinds: `warning`, `error`, `feedback`, `context`, `semantic`
- optional semantic summary
  - a small event-specific summary field is allowed on the run record
  - but canonical semantic aggregation still lives in the event-specific dispatchers (`input`, `before_agent_start`, `tool_call`, `tool_result`)

Important decision:

- keep the run record separate from event-specific semantic state machines
- the run record reports what happened operationally
- the dispatchers still own semantic chaining over latest state

This separation matches the current Pi Hooks seam better than trying to make one object do both jobs.

Implementation consequence:

`ActiveHookExecution` should evolve from process-control-only state into a richer session-scoped runtime record, with child-process control attached to the run rather than tracked separately.

## #4: What should the visible UI surface be?

Blocked by: #3
Type: Prototype

### Question

What operator-facing visible UI surface should Pi Hooks have?

### Answer

Resolved.

The visible UI surface should be exactly one compact footer status via `ctx.ui.setStatus(...)`.

Not part of the visible UI surface:

- widgets
- routine notifications
- a second visible panel for hook history
- custom Pi-core protocol work

Why:

- Pi already has a simple keyed footer-status API that fits active hook-run aggregation well
- one compact footer status matches the desired operator experience
- richer visibility can stay non-visual and command-driven if needed later

This means the operator-facing visible loop should be:

- active runs update one compact footer status
- the footer clears when no hooks are active
- exceptional failures may still notify, but notifications are not treated as part of the visible hook UI surface

## #5: How should `statusMessage` behave in Pi Hooks?

Blocked by: #3, #4
Type: Discuss

### Question

Pi Hooks already loads `statusMessage` from config, but does not surface it. What exact rules should determine when it appears, how multiple active hooks collapse, and when it clears?

### Answer

Resolved.

`statusMessage` should be config-owned, active-run-only, and aggregated by Pi Hooks rather than emitted by hook stdout.

Rules:

- only active hook runs participate
- sort active runs by `(startedAt, displayOrder, id)` for deterministic collapse
- if there are no active runs, clear the status with `ctx.ui.setStatus(key, undefined)`
- if there is exactly one active run:
  - show its configured `statusMessage` when present
  - otherwise show a Pi-owned fallback like `Running <eventName> hook`
- if there are multiple active runs:
  - show a compact aggregate like `Running 3 hooks: Loading session notes (+2 more)`
  - use the first active run’s configured `statusMessage` when present as the lead label
  - otherwise use a Pi-owned fallback label derived from the first active run’s event

Non-rules:

- do not let hooks set transient status text through stdout
- do not notify on every status change
- do not keep completed statuses pinned in the footer; completed history belongs in the run buffer and debug-oriented internal inspection paths if we need them later

Why:

- this keeps status text trusted and predictable
- it reuses the already-loaded `statusMessage` field
- it avoids footer flicker while still giving the operator immediate visibility that hooks are in flight

## #6: How should fire-and-forget observe-only hooks appear operationally?

Blocked by: #3
Type: Discuss

### Question

Observe-only hooks currently run via fire-and-forget `void runCommandHook(...)`. Should they stay invisible, become background tracked runs, or be surfaced only on failure?

### Answer

Resolved.

Fire-and-forget observe-only hooks should become background tracked runs, not invisible runs.

Model:

- keep their semantic contract unchanged: they remain observe-only and non-blocking
- create a `HookRunRecord` synchronously as soon as the hook is selected
- mark it `running` while the subprocess is in flight
- finalize it asynchronously when the subprocess exits
- attach warnings/errors/ignored-stdout diagnostics to that run record
- include those runs in the active footer status while they are still live
- do not surface routine completion in visible UI; keep it in run state only
- use notifications only for notable failures such as timeout or repeated malformed semantic-looking stdout on important seams

Important boundary:

- background tracking must not accidentally make observe-only hooks awaited from Pi’s point of view
- this is an operational visibility change only, not a semantic/runtime-order change

This closes the gap revealed by issue `#22`: late warnings finally have an owning run record.

## #8: What is the correct status taxonomy for Pi Hooks?

Blocked by: #3, #6
Type: Discuss

### Question

Should Pi Hooks mirror Codex’s coarse statuses exactly, or should it expose Pi-specific outcomes like timeout/abort/shutdown distinctly?

### Answer

Resolved.

Keep the status taxonomy minimal and Pi-native. Do not carry more top-level fields than the current Pi Hooks seam needs.

Use:

- `status`
  - `running`
  - `completed`
  - `failed`
  - `blocked`
  - `stopped`
- `reason?`
  - only present when `status` alone is not enough
  - values:
    - `timeout`
    - `abort`
    - `shutdown`
    - `spawn_error`
    - `stdin_error`
    - `nonzero_exit`
    - `invalid_stdout`

Do not add a separate `semanticOutcome` field to the generic run record.

Why:

- Pi Hooks already has event-specific semantic state machines for `input`, `before_agent_start`, `tool_call`, and `tool_result`
- those dispatchers already know whether a result was `continue`, `transform`, `handled`, message injection, prompt replacement, input patching, blocking, or result patching
- duplicating those distinctions into a generic operational record would burden the shared runtime model with event-specific detail that the footer status does not need

Mapping rules:

- normal success, including observe-only no-op success -> `completed`
- semantic terminal block (`tool_call`) -> `blocked`
- operator/runtime interruption before normal completion -> `stopped` with `reason` `timeout` / `abort` / `shutdown`
- malformed/unsupported stdout that Pi Hooks intentionally ignores fail-open -> `failed` with `reason: invalid_stdout`
- process/non-zero/spawn/stdin failures -> `failed` with the corresponding `reason`
- `input` `handled` stays `completed`; it is a semantic terminal result, not an operational failure or operator stop

If later debugging needs a little more semantic color, add it as a typed run entry, not as new always-present top-level fields.

This keeps the shared hook-run model lean while staying expressive enough for the compact footer status and notable failure notifications.

## #9: Should hook-run observability stay extension-owned, or do we need Pi core protocol work?

Blocked by: #4
Type: Research

### Question

Can Pi Hooks deliver a useful operational loop entirely through current extension APIs (`ctx.ui.setStatus`, `notify`), or is there a real need for deeper Pi protocol support?

### Answer

Resolved.

For the useful operational loop defined in this map, hook-run observability should stay extension-owned.

Use current Pi extension surfaces:

- `ctx.ui.setStatus(...)` for the compact active-run footer status
- `ctx.ui.notify(...)` only for notable failures/timeouts

Do not block this work on Pi core protocol changes.

Caveat:

- the current docs do not show an obvious extension API for emitting arbitrary custom streamed RPC events
- so if we later want Codex-like started/completed events in the external protocol, that can become a later follow-up
- but it is not required for the scoped operational loop here

## #10: What is the smallest implementation slice that proves the architecture?

Blocked by: #3, #4, #5, #6, #8, #9
Type: Discuss

### Question

What should be the first shippable slice for Pi Hooks operational loop work?

### Answer

Resolved.

The smallest shippable slice that proves the architecture is:

1. introduce `HookRunRecord` state for every selected hook
2. track both awaited semantic hooks and fire-and-forget observe-only hooks through that same model
3. drive one compact footer status from active runs using `statusMessage`
4. keep enough internal run state to finalize background runs correctly
5. reserve notifications for notable failures/timeouts only

Deliberately not in the first slice:

- custom Pi-core protocol work
- widgets
- cross-session persistence
- metrics/analytics export
- a command-based inspection surface
- arbitrary hook-owned status text from stdout

Why this is the right proving slice:

- it exercises the full architectural seam, including asynchronous observe-only runs
- it proves the deep module boundary (`HookRunRecord`) is useful to live status aggregation
- it is small enough to ship without changing the existing semantic hook contract

Implementation order inside the slice:

1. evolve `ActiveHookExecution` into richer run state
2. centralize run creation/finalization in `runCommandHook(...)`
3. record entries instead of only warning text
4. wire active-run aggregation into `ctx.ui.setStatus(...)`

With this ticket resolved, the path to implementation is clear and the decision map is done.
