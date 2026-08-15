# 4. Split Pi Hooks operational output across dedicated seams

Date: 2026-08-15

## Status

Accepted

## Context

`pi-hooks` currently concentrates operator-visible runtime output in a single seam:

- `safeNotify(...)` → `ctx.ui.notify(...)`

This includes:

- hook start/status messages
- parsed `PI_HOOK_NOTIFY:` stderr messages
- finalize/failure/block notifications

That choice was deliberate and is already recorded in:

- `docs/decision-maps/pi-hooks-operational-loop.md`

In particular, this ADR is a narrow reversal of the notify-only operational surface decisions recorded there, especially resolutions `#4` and `#9`.

This problem is distinct from `before_agent_start` semantic aggregation. That seam was already addressed by:

- `docs/adr/0002-split-before-agent-start-semantic-hooks-at-the-native-pi-seam.md`

The remaining tension is operational: same-level notification output is easy to supersede/override, so log-like hook output does not persist as well as the reference design seen in `pi-context-prune`.

## Reference observation: `pi-context-prune`

Inspected upstream:

- <https://github.com/championswimmer/pi-context-prune>

Observed output split:

- **durable operator-visible summaries** via custom message entries and a custom message renderer
- **runtime-delivered durable summaries** via `pi.sendMessage(..., { deliverAs: "steer" })`
- **status/progress surfaces** via footer/widget APIs
- **small notices/errors** via `ctx.ui.notify(...)`
- **durable internal state** via non-rendered custom entries

Important distinction:

- `appendCustomMessageEntry(...)` / `sendMessage(...)` support durable operator-visible content
- `appendCustomEntry(...)` supports durable internal state

`pi-context-prune` therefore does not rely on notifications as its only operator-visible surface.

## Decision

`pi-hooks` will no longer use a notify-only operational output model.

Instead, it will split operator-visible output across three seams:

1. **Ephemeral notify seam**
   - Keep `ctx.ui.notify(...)`
   - Use for high-signal alerts only
   - Phase 1 preserves the notify-worthy event set already established by `#25` Slice B: failed, blocked, and start `statusMessage` events

2. **Durable operator-log seam**
   - Add durable operator-visible entries keyed to `HookRunRecord`
   - Persist them with `appendCustomMessageEntry(..., display:false)`
   - Render them through a dedicated custom message renderer
   - Default presentation is a stored custom message entry rendered inline in transcript/TUI flow
   - Entry granularity is **one durable rendered entry per `HookRunRecord`**, with event-level detail nested inside that entry rather than emitted as a second event stream
   - Phase 1 default delivery is to write the durable operator-log entry at run finalization
   - Phase 2 may add runtime delivery via `pi.sendMessage(..., { deliverAs: "steer" })` if earlier in-turn visibility is needed

3. **Status/progress seam**
   - Add a lightweight in-flight status surface for current hook activity
   - Phase 1 status primitive is `ctx.ui.setStatus(...)`
   - Use it for cheap aggregate state such as “N hooks running”
   - Richer widget/progress surfaces are deferred to Phase 2

## Superseded prior decisions

This ADR supersedes the notify-only operational output choices in:

- `docs/decision-maps/pi-hooks-operational-loop.md` resolution `#4`
- `docs/decision-maps/pi-hooks-operational-loop.md` resolution `#9`

This is a reversal of prior resolved decisions, not merely a revisit of an undocumented gap.

## Non-decisions / unchanged decisions

This ADR does **not** change:

- event matching semantics
- hook selection semantics
- `before_agent_start` native seam behavior from ADR 0002
- the existing choice that `HookRunRecord` is the unit of operational state

The unit is already chosen. The open question is only which visible seam reflects that unit and how that seam presents it.

## Rationale

### Why reverse notify-only?

Notifications are suitable for urgent, ephemeral signals, but they are a poor fit for log-like operational output because later notifications supersede earlier ones.

### Why a durable operator log?

`pi-hooks` already has a per-run operational unit (`HookRunRecord`). Durable operator-visible entries let the UI reflect that unit without forcing all output through transient notices.

### Why separate durable log from internal state?

The reference repo distinguishes:

- durable visible summaries/messages
- durable invisible bookkeeping/index state

`pi-hooks` should preserve that distinction rather than treating all persistence as one mechanism.

### Why add status separately?

In-flight state is not the same thing as durable history. A running-count/footer seam answers “what is happening now?” while the durable operator log answers “what happened for this hook run?”

## Initial implementation direction

Start with the smallest reversal that matches the reference pattern.

### Phase 1: option B

Add dedicated seams alongside existing notifications:

- keep notify for the existing `#25` Slice B event set
- add a durable operator-log adapter that writes one rendered entry per `HookRunRecord` at finalization
- add a minimal aggregate status adapter via `ctx.ui.setStatus(...)`

Use direct calls from the runtime sites that already own these concerns.

### Phase 2: only if needed

If output routing logic becomes scattered or policy-heavy, introduce a `HookOutputBus` / `HookJournal` abstraction later.

Also in Phase 2, consider:

- runtime steer-delivered durable log entries
- richer `setWidget(...)` / `setWorkingIndicator(...)` progress UI

A bus is explicitly deferred; it is not required for the first slice.

## Consequences

### Positive

- avoids same-level supersession for log-like output
- aligns `pi-hooks` operational surfaces more closely with observed Pi extension patterns
- preserves notify for the cases where notify is appropriate
- keeps the first implementation slice narrow

### Negative / costs

- reverses two previously resolved decisions
- adds at least one new persistent/rendered surface to the extension
- future hook events must be routed intentionally across notify vs durable-log vs status seams
- introduces a distinction between durable visible log state and durable internal state that code must maintain carefully

## Implementation notes

- Prefer `HookRunRecord` as the key for durable operator-log entries
- Keep `appendCustomEntry(...)` reserved for internal state/bookkeeping, not operator-visible log content
- Prefer `appendCustomMessageEntry(...)` plus a renderer for durable operator-visible history
- In Phase 1, write durable operator-log entries at finalization rather than adding steer delivery immediately
- Use `ctx.ui.setStatus(...)` first for aggregate running state; richer widget detail can follow later if justified

## Implementation follow-ups

- Confirm whether the durable operator-log renderer should remain inline in transcript flow or later move to a dedicated panel/secondary surface
- Define the exact per-event routing table, with the default rule: keep the existing `#25` Slice B notify set and route all other operational output off the notify seam
- Sequence the migration so finalization-time durable operator-log entries and `ctx.ui.setStatus(...)` land before any optional Phase 2 steer/widget work

## References

- `docs/adr/0002-split-before-agent-start-semantic-hooks-at-the-native-pi-seam.md`
- `docs/decision-maps/pi-hooks-runtime.md`
- `docs/decision-maps/pi-hooks-operational-loop.md`
- Research target: <https://github.com/championswimmer/pi-context-prune>
