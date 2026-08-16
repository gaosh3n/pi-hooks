# Pi Hooks: operational loop and hook-run observability

Related assets:

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

Per `docs/adr/0004-split-pi-hooks-operational-output-across-dedicated-seams.md` and `docs/adr/0005-extend-durable-operator-log-seam-to-helper-script-output-via-pi-hook-msg.md`, the visible hook UI surface should be split across dedicated Pi-native seams. This reverses the earlier notify-only choice.

Visible surfaces:

- `ctx.ui.notify(...)` through `safeNotify(...)` for high-signal alerts
- durable operator-log entries via `appendCustomMessageEntry(..., display:false)` plus a custom renderer, covering both runtime per-run history (ADR 0004) and helper-script output (ADR 0005)
- `ctx.ui.setStatus(...)` for lightweight aggregate in-flight status

Helper-script output has two stderr prefixes (ADR 0005):

- `PI_HOOK_NOTIFY:` routes to the ephemeral `ctx.ui.notify(...)`, unchanged from prior behavior
- `PI_HOOK_MSG:` routes to the durable `custom_message` seam (one persisted, non-superseding entry per envelope, rendered in transcript)

Not part of the visible UI surface in Phase 1:

- custom Pi-core protocol work
- richer widget/progress UI
- a second dedicated panel for hook history

Why:

- notifications remain the right seam for configured start messages and notable failed/blocked signals
- a durable operator log avoids same-level supersession for per-run history and helper-script output
- aggregate status answers “what is happening now?” separately from durable per-run history
- current Pi extension APIs already support this split without Pi core changes

This means the operator-facing visible loop should be:

- a configured `statusMessage` emits one informational notification when its hook starts
- notable failures and blocks continue to use the same notification path
- each `HookRunRecord` gets one durable rendered operator-log entry when it finalizes
- each `PI_HOOK_MSG:` envelope gets one durable rendered operator-log entry (ADF 0005)
- aggregate in-flight hook activity is reflected through `ctx.ui.setStatus(...)`
- operator-visible warnings/failures must use Pi-native UI surfaces rather than raw console warnings

## #5: How should `statusMessage` behave in Pi Hooks?

Blocked by: #3, #4
Type: Discuss

### Question

Pi Hooks already loads `statusMessage` from config. What exact notification rules should determine when it appears and how concurrent hooks are handled?

### Answer

Resolved.

`statusMessage` remains config-owned and emitted through `safeNotify(...)` as a start notification. Per ADR 0004, it is not the source of aggregate `ctx.ui.setStatus(...)` text, and it does not own durable per-run history.

Rules:

- when a selected hook has a configured `statusMessage`, emit it once when the hook run starts
- use the informational notification level
- emit each configured message independently; do not aggregate concurrent start notifications
- hooks without `statusMessage` do not emit a replacement fallback notification
- stale or unavailable UI contexts are handled by `safeNotify(...)`

Non-rules:

- do not render per-hook configured `statusMessage` text through `ctx.ui.setStatus(...)`
- do not notify again when a run completes
- do not treat start notifications themselves as durable run history; finalization-time operator-log entries own that history
- do not let hooks set transient notification text through stdout

Why:

- this preserves the existing configuration key and the `#25` Slice B notify-worthy start behavior
- it keeps aggregate in-flight status extension-owned rather than hook-text-owned
- it separates transient start notices from durable per-run history

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
- emit a configured `statusMessage` once at start through `safeNotify(...)`
- reflect in-flight hook activity through the aggregate `ctx.ui.setStatus(...)` seam while the run is active
- write one durable operator-log entry when the run finalizes rather than emitting a separate routine-completion notification
- use notifications only for notable failures such as timeout or repeated malformed semantic-looking stdout on important seams; this threshold is a **notification-layer display gate**, not a classification-layer suppression — the classifier (#25 decision map) always records all classifications (`failed`/`blocked`/`stopped`), and the notifier decides what to surface. `stopped` runs (timeout/abort/shutdown) are non-failures and never notify

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
- duplicating those distinctions into a generic operational record would burden the shared runtime model with event-specific detail that the notification surface does not need

Mapping rules:

- normal success, including observe-only no-op success -> `completed`
- semantic terminal block (`tool_call`) -> `blocked`
- operator/runtime interruption before normal completion -> `stopped` with `reason` `timeout` / `abort` / `shutdown`
- malformed/unsupported stdout that Pi Hooks intentionally ignores fail-open -> `failed` with `reason: invalid_stdout`
- process/non-zero/spawn/stdin failures -> `failed` with the corresponding `reason`
- `input` `handled` stays `completed`; it is a semantic terminal result, not an operational failure or operator stop

If later debugging needs a little more semantic color, add it as a typed run entry, not as new always-present top-level fields.

This keeps the shared hook-run model lean while staying expressive enough for start notifications, notable failure notifications, one durable per-run operator-log entry at finalization, one durable `PI_HOOK_MSG:` entry per helper-script envelope (ADR 0005), and aggregate in-flight status.

## #9: Should hook-run observability stay extension-owned, or do we need Pi core protocol work?

Blocked by: #4
Type: Research

### Question

Can Pi Hooks deliver a useful operational loop entirely through current extension APIs (`notify`, message entries, status), or is there a real need for deeper Pi protocol support?

### Answer

Resolved.

Per ADR 0004 and ADR 0005, the useful operational loop defined in this map should stay extension-owned.

Use the current Pi extension surface:

- `ctx.ui.notify(...)` through `safeNotify(...)` for configured start messages and notable failed/blocked signals
- `appendCustomMessageEntry(..., display:false)` plus a custom renderer for durable operator-log entries, covering runtime per-run finalization (ADR 0004) and helper-script `PI_HOOK_MSG:` output (ADR 0005)
- `ctx.ui.setStatus(...)` for lightweight aggregate in-flight status

Helper-script prefixes (ADR 0005):

- `PI_HOOK_NOTIFY:` stays ephemeral (`safeNotify(...)` → `ctx.ui.notify(...)`)
- `PI_HOOK_MSG:` routes to the durable `custom_message` seam, one persisted non-superseding entry per envelope

Constraint:

- raw console warnings are not part of the operator-facing hook surface; operator-visible hook output should go through these Pi-native surfaces rather than raw console warnings

Do not block this work on Pi core protocol changes.

Caveat:

- richer widget/progress UI and runtime steer-delivered log entries remain later extension-level follow-ups
- if we later want Codex-like started/completed events in the external protocol, that can become a separate Pi-core follow-up
- but none of that is required for the scoped operational loop here

## #10: What is the smallest implementation slice that proves the architecture?

Blocked by: #3, #4, #5, #6, #8, #9
Type: Discuss

### Question

What should be the first shippable slice for Pi Hooks operational loop work?

### Answer

Resolved.

The smallest shippable slice that proves the architecture is the ADR 0004 Phase 1 split:

1. introduce `HookRunRecord` state for every selected hook
2. track both awaited semantic hooks and fire-and-forget observe-only hooks through that same model
3. emit configured `statusMessage` values through `safeNotify(...)` at run start
4. keep enough internal run state to finalize background runs correctly
5. write one durable operator-log entry per `HookRunRecord` at finalization
6. expose aggregate in-flight activity through `ctx.ui.setStatus(...)`
7. keep notifications for the existing `#25` Slice B notify-worthy set rather than using them as the only visible seam

Deliberately not in the first slice:

- custom Pi-core protocol work
- richer widget/progress UI
- runtime steer-delivered durable log entries
- cross-session persistence
- metrics/analytics export
- a command-based inspection surface
- arbitrary hook-owned status text from stdout

Why this is the right proving slice:

- it exercises the full architectural seam, including asynchronous observe-only runs
- it proves the deep module boundary (`HookRunRecord`) remains useful while UI delivery is split by concern rather than centralized on notify alone
- it is small enough to ship without changing the existing semantic hook contract

Implementation order inside the slice:

1. evolve `ActiveHookExecution` into richer run state
2. centralize run creation/finalization in `runCommandHook(...)`
3. record entries instead of only warning text
4. route configured start messages through `safeNotify(...)`
5. append finalization-time durable operator-log entries
6. maintain aggregate running state through `ctx.ui.setStatus(...)`

With this ticket resolved, the path to implementation is clear and the decision map is done.

---

# Decision Map — Pi Hooks hook-run classification (#25 blockers)

Resolved (Pi-native). Codex research asset: `docs/research/codex-hook-run-classification.md`.
Decisions below **defer to** `pi-hooks-operational-loop.md` #8 (pre-existing Pi-native status
mapping) and `pi-hooks-runtime.md` #5 (session-scoped, clear on `session_shutdown`).

Pi-native north star: Pi is a TypeScript extension with **no outbound protocol event** and a
`runCommandHook` that finalizes-in-`finally` (#24). Codex is guidance, not law. operational-loop
#8 already made the deliberate Pi-native divergences from Codex on the two contested points
(`input` handled → `completed`, not a separate status; interruption → `stopped`, not `failed`).
This map does NOT override #8 — it inherits it. Where Codex helped: the runner-owns-timing vs
dispatcher-owns-status+entries split (option a), the 5-kind typed-entry shape, the collapse of
invalid-stdout into `failed`+entry, and the emit-all-then-gate layering for notifications.

## #1: How are hook runs classified into terminal status + typed entries? (B3)

Blocked by: —
Type: Research — RESOLVED

### Question

Where does terminal classification live — runner or dispatcher — and what is the status taxonomy

- typed-entry shape for the first slice? How to classify `blocked` (tool_call), `input` handled,
  `before_agent_start` shaping, failures, interruption, and invalid semantic stdout?

### Answer

**Split: mirror Codex — runner owns timing, dispatcher owns status+entries (option a).**
`finishHookRun` (in the runner's `finally`, per #24) writes the finalized record into a new
**session-scoped `finalizedHookRuns` store** (cleared on `session_shutdown` per runtime #5) with
terminal timing + operational status (`completed`/`failed`/`stopped`+`reason`+`completedAt`)
**instead of deleting it**. The dispatcher then **augments** the persisted record with terminal
classification (`blocked`) + typed `entries[]`. This preserves #25 acceptance criterion 2 ("late
failures finalize through the same runner path as awaited hooks") — finalize stays a single point
in the runner; the dispatcher only augments.
_Divergence from Codex forced:_ Codex emits `running_summary`+`completed_summary` as protocol
events and retains nothing; Pi has no outbound protocol event, so the session-scoped store is the
only observable channel. This store is **internal ownership state** for classification
observability — NOT the deleted #7 cross-run inspection UI (that was user-facing cross-session;
this is session-scoped, cleared on shutdown, internal-only).

**Taxonomy: 5 statuses — inherit `pi-hooks-operational-loop.md` #8 verbatim (Pi-native, not
re-derived from Codex):** `{running, completed, failed, blocked, stopped}`:

- `running` — in-flight (#24).
- `completed` — normal success, incl. observe-only no-op, successful `before_agent_start` shaping
  (system-prompt replacement / message injection — Pi-native: this event **shapes**, it does not
  stop the turn), successful `tool_result` feedback, **and `input` `handled`** (per #8: _"input
  handled stays completed; it is a semantic terminal result, not an operational failure or operator
  stop"_). Semantic color for handled is carried by a typed entry, NOT a status.
- `failed` — spawn_error / stdin_error / nonzero_exit / **invalid-semantic-stdout**.
  **Collapsed** (mirrors Codex): invalid-stdout is NOT a 6th status and is NOT `stopped`; it is
  `failed` with `reason: invalid_stdout` (#8) + an `error` entry whose text identifies it. This
  keeps taxonomy at 5 and gives #3 a countable `failed`+`error` signal.
- `blocked` — `tool_call` `decision:block` with non-empty reason (terminal). Status-level per #8.
- `stopped` — operator/runtime interruption before normal completion, with `reason` `timeout` /
  `abort` / `shutdown` (#8). **Pi-native divergence from Codex:** Codex has no abort/shutdown path
  and routes timeout→`failed`; Pi treats interruption as a distinct non-failure operational
  terminal `stopped`. Do NOT copy Codex's `timeout→failed`.

**Typed entries: 5 kinds, Pi-native names** `{warning, stop, feedback, context, error}` (per #8:
"add semantic color as a typed run entry, not as new always-present top-level fields"):

- `warning` — `systemMessage` from a semantic envelope.
- `stop` — `input` handled take-over reason text (semantic color for the `completed`-with-handled
  run, since `handled` is NOT a status).
- `feedback` — `tool_call` block reason fed to model + injected context (`tool_result` /
  `before_agent_start`).
- `context` — plain non-JSON stdout as context (observe-only context-setting run).
- `error` — failure text; text discriminates the failure kind (spawn/stdin/nonzero/invalid-stdout)
  so #3 can count invalid-stdout without a 6th status. `stopped` runs do NOT get `error`
  entries — interruption is not a failure (its reason lives in the top-level `reason` field, #8).

`completedAt` always set on finalize; `startedAt` from `startHookRun`.

## #2: What precedence applies when a run is both cancelled/interrupted and semantically terminal? (B2)

Blocked by: #1
Type: Research — RESOLVED

### Question

If a child writes a valid `block`/`handled` envelope AND is simultaneously aborted/timed-out/
shutdown-cancelled, which terminal wins? Is the semantic envelope observable at all on an
interrupted run?

### Answer

**Interruption wins; a semantic terminal cannot be observed on a cancelled/aborted/timed-out
run.** No exceptions in the first slice. Matches current Pi behavior (any `cancellationReason`
short-circuits before the stdout-parse branch, so stdout is never parsed → dispatcher gets
`undefined`) and Codex's structural behavior (timeout discards stdout → no envelope observable).

**Interruption → `stopped` + `reason` (Pi-native per #8), NOT `failed`.** This is the deliberate
Pi-native divergence from Codex (which routes timeout→`failed` because it has no abort/shutdown
path). Routes:

- timeout → `stopped`, `reason: "timeout"` (Pi-native; Codex-guided `failed` rejected as
  non-Pi-native).
- abort (user cancel) → `stopped`, `reason: "abort"`.
- shutdown (operator teardown, per runtime #5) → `stopped`, `reason: "shutdown"`.

No `error` entry on `stopped` (interruption is not a failure; reason is the discriminator). The new
globals reset #24 added (`activeHookRuns`, `nextHookRunDisplayOrder`) plus
the new `finalizedHookRuns` store are all cleared on `session_shutdown` per runtime #5 — so a run
in flight at shutdown is finalized to `stopped`+`reason:shutdown` before/into the clear (the
runner's `finally` runs first; `cancelActiveHookExecutions("shutdown")` already triggers this).

## #3: What does #25 emit for a later notification slice, and what triggers it? (B1)

Blocked by: #1, #2
Type: Research — RESOLVED

### Question

Does #25 (classification-only) need to emit anything consumable by a future notification slice, or
only classify in-session state? If emit: what status set triggers it, is there a repetition
threshold for repeated invalid/failed stdout, and are seam-importance + operator-initiated
(`shutdown`/`abort`) silencing required?

### Answer

**#25 records classification AND wires notification in the same issue** (folded, no follow-up
issue). The session-scoped `finalizedHookRuns` store from #1 IS Pi's "emit" — an extension has no
protocol broadcast. A second slice inside #25 reads that store and applies the notification gate.
This collapses the blocked dependency chain the original "defer to a follow-up" plan would have
created, and matches the existing #25 body's permissive "notable failures/timeouts may use the
already-approved notification path" note (now made concrete). The issue stays vertical-TDD
friendly by being structured as two labeled slices: Slice A (classification + finalized store) and
Slice B (notification wiring reading the store).

**Trigger threshold: defined in #25's notification slice (Slice B), not deferred.** Codex research
validated the layering (classifier records all; surface gates) but NOT that the gate belongs in a
separate issue. #25 Slice B applies the gate per operational-loop #6 (reworded): classify faithfully
in Slice A; gate in Slice B. Concretely: notify on `failed` (spawn/stdin/nonzero/invalid_stdout)
and optionally `blocked`; **never** notify on `stopped` (timeout/abort/shutdown are non-failures,
so operator teardown is structurally silenced with no extra field); apply a **repetition
threshold** for repeated `failed`+`invalid_stdout` (≥ N occurrences on the same seam within the
session) and a **seam-importance gate** (important seams = the 4 semantic-stdout events
`input`/`before_agent_start`/`tool_call`/`tool_result` where classification has semantic meaning;
observe-only non-semantic-stdout runs that fail nonzero are fail-open and do not notify).

**Note: `stopped` runs are inherently non-failures** (#1/#2), so a notification slice keying on
"failures" (`failed`/`blocked`) naturally never fires on `timeout`/`abort`/`shutdown`. This means
the operator-teardown silence the reviewer worried about is already structurally handled by the
`stopped`≠`failed` split (Pi-native, #8) — no extra silence-mask field is needed. `blocked` may or
may not notify (it's a deliberate hook block, not a failure); defer that choice to the
notification slice.

**Reconciling edit to `pi-hooks-operational-loop.md` #6** (applied separately): reword to specify
that _"repeated malformed semantic-looking stdout on important seams"_ is a **notification-layer
display gate**, not a classification-layer suppression. The classifier always records; the
notifier decides what to surface. This resolves the tension between Codex's emit-all approach and
#6's nuanced wording without weakening either: faithful classification + gated notification.

## Map status: DONE

Frontier cleared. Path to #25 spec revision is unambiguous:

1. Spec #25 pins: option-(a) split + session-scoped `finalizedHookRuns` store (cleared on
   `session_shutdown`); inherit operational-loop #8's 5-status taxonomy `running|completed|failed|
blocked|stopped`; 5-kind `warning|stop|feedback|context|error` entries; `failed` collapses
   invalid-stdout (reason `invalid_stdout` + `error` entry); interruption→`stopped`+reason
   (timeout/abort/shutdown), NOT `failed`; `input` handled→`completed`+`stop` entry.
2. Spec #25 scope: Slice A = classification + session-scoped `finalizedHookRuns` store (cleared on
   `session_shutdown`); Slice B = notification wiring reading the same store. Single issue, two
   labeled vertical-TDD slices. No follow-up issue, no #26.
3. Slice B gate (concrete): notify on `failed` (reasons spawn/stdin/nonzero/invalid_stdout) and
   `blocked`; never on `stopped`; repetition threshold ≥ N repeated `failed`+`invalid_stdout` per
   seam per session; seam-importance gate = semantic-stdout events only; observe-only nonzero-exit
   failures are fail-open and do not notify.

One external edit required: reword `pi-hooks-operational-loop.md` #6 (notification-layer gate).
