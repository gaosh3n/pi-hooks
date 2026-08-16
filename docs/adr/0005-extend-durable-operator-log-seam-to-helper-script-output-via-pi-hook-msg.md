# 5. Extend the durable operator-log seam to helper-script output via PI_HOOK_MSG

Date: 2026-08-16

## Status

Accepted

## Context

ADR 0004 introduced a durable operator-log seam for `pi-hooks` runtime output. Phase 1 shipped that seam for `HookRunRecord` finalization entries: each finalized hook run writes one durable `pi-hooks-hook-run` custom message entry via `appendCustomMessageEntry(..., display:false)`, rendered inline in the transcript/TUI.

However, ADR 0004 scoped the durable seam to runtime `HookRunRecord` history only. It did **not** give helper scripts a way to reach the durable seam. Today, the only helper-script channel is the `PI_HOOK_NOTIFY:` stderr prefix, which routes parsed envelopes directly to `safeNotify(...)` → `ctx.ui.notify(...)` in `src/index.ts`.

### Why this is a problem

`ctx.ui.notify(...)` in current Pi is inherently ephemeral:

- `info`-level notifications reuse the previous info text node, so a later info message **replaces** the earlier one (literal same-level supersession)
- `warning`/`error` notifications stack as inline transcript lines but scroll away with chat; they are not durable

So operator-meaningful output from helper scripts (for example `list-pi-resources.mjs` summaries, package-update notices, or any structured helper message) has no durable path today — it is all subject to supersession or loss. This directly defeats the user's stated goal for introducing the durable seam in the first place: a unified operator-output channel where same-level entries do not erase each other, with **both** a durable option and an ephemeral option accessible from **both** internal runtime code and helper scripts.

### What `pi-context-prune` actually does

Re-verified upstream: `pi-context-prune` does **not** solve `ctx.ui.notify` supersession internally — it cannot, that is Pi-core behavior. It keeps `ctx.ui.notify(...)` for small ephemeral command feedback (enabled/disabled/stat echoes) and moves the **heavy, must-persist content** (summaries, indices, stats) onto durable `custom_message` entries that persist to the session JSONL and render inline. Those entries do not supersede because each is a distinct persisted record.

The unified non-superseding "notification" the user is asking for is therefore the durable seam itself, not `ctx.ui.notify`. ADR 0004 built that seam for runtime history; ADR 0005 extends it to helper-script output.

## Scope of this ADR

This ADR gives both pi-hooks audiences — internal runtime code and helper scripts — access to **both** operator-output options, mirroring `pi-context-prune`:

- an **ephemeral** option (small, transient notices via `ctx.ui.notify(...)`)
- a **durable** option (persisted `custom_message` entries via the durable operator-log seam)

Internal code already has both via direct API calls (`ctx.ui.notify` for ephemeral, `appendCustomMessageEntry` for durable). Helper scripts only have stderr prefixes as their channel, so this ADR introduces a new durable prefix alongside the existing ephemeral one. It is **not** an attempt to change `ctx.ui.notify` internals (that is Pi-core behavior extensions cannot alter).

## Decision

Introduce a **new** stderr prefix, `PI_HOOK_MSG:`, for durable helper-script output. Keep the existing `PI_HOOK_NOTIFY:` prefix ephemeral and unchanged. This preserves backwards compatibility for existing helper scripts while giving new ones opt-in access to the durable seam.

1. **New durable prefix `PI_HOOK_MSG:`**
   - Parsed `PI_HOOK_MSG:` envelopes are appended as durable custom message entries via `appendCustomMessageEntry(..., display:false, { level, ...details })`
   - Payload schema is **identical** to `PI_HOOK_NOTIFY:` (`{ message, level? }`), so authors learn two prefixes, not two payload shapes
   - Use a dedicated custom type, `pi-hooks-hook-notify`, distinct from the runtime `pi-hooks-hook-run` type
   - **One `PI_HOOK_MSG:` envelope → one durable `pi-hooks-hook-notify` entry** (envelopes are the natural unit; they already represent one operator message each)
   - Preserve the envelope's `level` (`info`/`warning`/`error`, defaulting to `info` if absent) into the entry `details`; surface it in the renderer so the operator can distinguish severity
   - Preserve the originating hook command/run association into `details` where available
   - `level: warning`/`error` is the higher-value use case for the durable channel; info-level ephemeral feedback is better left on `PI_HOOK_NOTIFY:`

2. **Ephemeral prefix `PI_HOOK_NOTIFY:` unchanged**
   - `PI_HOOK_NOTIFY:` keeps its current behavior: ephemeral `ctx.ui.notify(...)` via `safeNotify(...)`
   - A bare `PI_HOOK_NOTIFY:` envelope (no level) remains ephemeral, info-level — exactly today's behavior
   - A bare `PI_HOOK_MSG:` envelope (no level) is durable, info-level — new, opt-in
   - Each prefix has its own default; there is no cross-prefix "default" notion, so the both-options requirement is satisfied by the prefix choice itself, not by a field default

3. **Renderer**
   - Register a custom message renderer for `pi-hooks-hook-notify` that renders inline in transcript/TUI flow
   - Render the level (for example via theme color / prefix) and the message text
   - Phase 1 keeps this minimal; richer expandable detail is a follow-up

4. **`ctx.ui.notify(...)` retained role**
   - Keep `ctx.ui.notify(...)` only for genuinely ephemeral feedback that **should** replace or scroll
   - Phase 1 preserves the existing `#25` Slice B notify-worthy set: start `statusMessage`, failed, blocked
   - This mirrors `pi-context-prune`'s use of notify for ephemeral command feedback

5. **Invalid envelopes**
   - Invalid/parse-failure output for **either** prefix (`PI_HOOK_NOTIFY:` or `PI_HOOK_MSG:`) continues to use `reportWarning(...)` → `safeNotify(...)` as an extension-side diagnostic, since it is a pi-hooks-internal protocol error rather than operator-authored helper content
   - This keeps the "invalid stdout" path consistent with the existing `invalid_stdout` run-record handling

## Superseded prior decisions

This ADR partially supersedes the implicit ADR 0004 default that helper-script output stays on the notify seam. ADR 0004 did not address helper-script output explicitly; its notify/durable boundary left helper-script output on notify by omission. ADR 0005 closes that omission by adding the `PI_HOOK_MSG:` durable prefix.

It does **not** supersede ADR 0004's durable-log or status decisions; those stand. It extends the durable seam's reach to a second audience (helper scripts).

## Non-decisions / unchanged decisions

This ADR does **not** change:

- the existing `PI_HOOK_NOTIFY:` prefix semantics (still ephemeral); it **adds** the `PI_HOOK_MSG:` prefix rather than altering `PI_HOOK_NOTIFY:`
- the existing `PI_HOOK_NOTIFY:` payload schema
- `HookRunRecord` as the runtime per-run state unit
- ADR 0004's durable-log seam for runtime finalization history
- ADR 0004's status/progress seam
- the `#25` Slice B notify-worthy event set for ephemeral feedback
- event matching or hook selection semantics

## Rationale

### Why route `PI_HOOK_MSG:` to the durable seam?

Because that is the only lever extensions have against `ctx.ui.notify` supersession. Moving operator-meaningful content off notify onto persisted entries makes supersession irrelevant for the content that needs to persist — exactly the `pi-context-prune` pattern.

### Why a separate prefix instead of a `delivery` field on `PI_HOOK_NOTIFY:`?

- **Backwards compatibility**: existing `PI_HOOK_NOTIFY:` scripts keep their current ephemeral behavior with zero changes; opt-in to durable by emitting the new prefix. A field with a default would silently change the meaning of every existing envelope.
- **Per-channel contract**: the two channels have different supersession contracts by construction — ephemeral supersedes, durable does not. The prefix encodes that contract directly, so the author chooses the right channel first rather than a field value.
- **Artifact alignment**: `PI_HOOK_MSG:` names the persisted `custom_message` entry artifact on the durable seam; `PI_HOOK_NOTIFY:` names the ephemeral `ctx.ui.notify` seam. The names pair on artifact (MSG vs NOTIFY); their contracts differ on persistence.
- **Parser fit**: the current prefix dispatch (`startsWith`) extends cleanly to a second prefix without schema branching.

The pair's contract, stated in one line so the names do not have to carry it alone: `PI_HOOK_MSG:` routes to the durable `custom_message` seam (one persisted, non-superseding entry per envelope, rendered in transcript); `PI_HOOK_NOTIFY:` routes to the ephemeral `ctx.ui.notify` seam (may supersede/scroll).

### Why preserve `level` in details?

`pi-context-prune`'s durable entries are untyped summaries. `pi-hooks`' envelope already carries a `level` field, so pi-hooks can be richer than the reference: severity survives into the durable entry and the renderer can surface it, giving operators a durable leveled log rather than an opaque stream.

### Why keep `ctx.ui.notify` for the Slice B set?

`pi-context-prune` keeps notify for ephemeral command feedback. Start `statusMessage` and high-signal failure/block alerts are genuinely ephemeral signals that fit the replace/scroll semantics of notify. Routing them onto the durable seam would pollute durable history with transient noise and require an eviction policy.

### Why a separate custom type (`pi-hooks-hook-notify`)?

The two durable entry kinds have fundamentally different granularity and content shape:

- `pi-hooks-hook-run` entries are **one per finalized run** and **structured** (serialized run record with `status`/`reason`/`entries[]`).
- `pi-hooks-hook-notify` entries are **one per parsed envelope** (potentially many per run, not tied 1:1 to a run) and **leveled** (`info`/`warning`/`error`).

Mixing them into one custom type would force the renderer to branch on "is this a run record or a notify envelope?" via `details`-shape-sniffing — exactly the early-collapse ADR 0002 and ADR 0004 cautioned against. Separate types keep each renderer single-purpose and let future filtering/eviction treat helper-script messages differently from per-run finalization records.

## Consequences

### Positive

- closes the user's stated goal: same-level operator output no longer superseded, for both internal and helper-script output
- makes `list-pi-resources.mjs`-style summaries durable and reviewable
- preserves severity into a durable leveled log
- keeps notify's legitimate ephemeral role intact

### Negative / costs

- helper-script authors now have two prefixes to learn; emitting `PI_HOOK_MSG:` when a transient `PI_HOOK_NOTIFY:` was intended leaves durable transcript entries (a docs/discoverability cost, not a correctness cost). Existing `PI_HOOK_NOTIFY:` scripts are unaffected.
- adds a second custom message type and renderer to maintain
- future helper-script output must respect the channel contract: operator-meaningful → `PI_HOOK_MSG:`, genuinely-ephemeral → `PI_HOOK_NOTIFY:`
- **start `statusMessage` and failed/blocked remain ephemeral by design** (Slice B); an operator who wants a durable start record must emit a `PI_HOOK_MSG:` envelope from the helper script rather than relying on the start `statusMessage` field. This is a deliberate boundary, not an oversight: it mirrors `pi-context-prune`'s coexistence of ephemeral command feedback and durable summaries.

## Out of scope

- `ctx.ui.notify` internal supersession behavior (Pi-core owned)
- ADR 0004 Phase 2 deferrals: `HookOutputBus`, steer delivery, `setWidget`/`setWorkingIndicator` progress UI
- shutdown-cancelled-run durable logging (separate finalization-model candidate)

## Implementation follow-ups

- Define the exact `pi-hooks-hook-notify` entry shape: `{ level, message, eventName?, runId?, ... }`
- Add `HOOK_STDERR_MSG_PREFIX = "PI_HOOK_MSG:"` and a parser path parallel to the existing `PI_HOOK_NOTIFY:` parser (or a shared parser parameterized by prefix)
- Extend the renderer to show level (for example color/prefix)
- Update `docs/decision-maps/pi-hooks-operational-loop.md` so its durable-seam scope explicitly includes `PI_HOOK_MSG:` output, not just `HookRunRecord` finalization
- Re-run the runtime smoke against a helper script that emits multiple same-level `PI_HOOK_MSG:` envelopes to confirm non-supersession at runtime — concretely, emit two same-level `info` envelopes in a row and assert **two distinct durable entries** land in the session JSONL (not one replacing the other). This is the runtime proof of the user's same-level non-supersession goal.
- Document the two prefixes in the helper-script protocol docs so authors discover the durable channel

## References

- `docs/adr/0004-split-pi-hooks-operational-output-across-dedicated-seams.md`
- `docs/decision-maps/pi-hooks-runtime.md`
- `docs/decision-maps/pi-hooks-operational-loop.md`
- Research target: <https://github.com/championswimmer/pi-context-prune>