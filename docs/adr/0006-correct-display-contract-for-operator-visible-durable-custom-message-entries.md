# 6. Correct the live delivery and display contract for operator-visible durable custom_message entries

Date: 2026-08-16

## Status

Accepted

## Context

ADR 0004 introduced the seam split between ephemeral notify, durable custom-message output, and aggregate status. ADR 0005 extended the durable seam to helper-script output via `PI_HOOK_MSG:`.

At the time this ADR was accepted, the same live-delivery/display-contract bug affected two durable custom-message uses:

- runtime-owned `pi-hooks-hook-run` completion summaries
- helper-script-owned `pi-hooks-hook-notify` messages

The runtime-owned completion summaries were later removed as trivial routine output, but the delivery/display findings in this ADR remain relevant to helper-script durable messages and to any future operator-visible durable custom-message use.

Both earlier ADRs originally made the same display-contract claim:

- persist operator-visible durable output with `appendCustomMessageEntry(..., display:false)`
- register a custom message renderer
- expect the entry to render inline in the interactive transcript/TUI

Interactive verification disproved that claim. In the user's reported session, `.pi/pi-hooks/list-pi-resources.mjs` did emit a durable `pi-hooks-hook-notify` entry, and that entry persisted to the session JSONL, but the operator did not see any inline durable notification.

Re-verifying the shipped Pi source explained the first half of the bug.

In `interactive-mode.js`, Pi has two distinct rendering paths:

1. `addCustomEntryToChat(entry)`
   - uses `getEntryRenderer(entry.customType)`
   - is **not** gated by a `display` flag
   - corresponds to `appendCustomEntry(...)`

2. `addMessageToChat(message)` for `role: "custom"`
   - gates the entire inline-rendering path on `if (message.display)`
   - only then calls `getMessageRenderer(message.customType)` and constructs `CustomMessageComponent`
   - corresponds to live `custom_message` delivery

Verified in the shipped Pi source:

- `dist/modes/interactive/interactive-mode.js` lines around `2601`-`2636`
- specifically, `case "custom"` only renders when `message.display` is truthy

So `display:false` does **not** mean “persisted, custom-rendered, and still inline-visible.” It means “persisted, but skipped by the interactive custom-message transcript path.”

This means ADR 0004 and ADR 0005 both misread the reference pattern from `pi-context-prune`.

Re-verifying `pi-context-prune` shows:

- it also writes durable summaries with `appendCustomMessageEntry(..., false, ...)`
- it also registers a message renderer for those summaries
- but its operator-visible interactive surface comes from `ctx.ui.setStatus(...)` and `ctx.ui.setWidget(...)`, rather than the inline transcript path for those `display:false` custom messages

ADR 0006 initially corrected only the display flag (`display:false` -> `display:true`). That correction was necessary, but later interactive verification showed it was insufficient for first-run visibility.

The observed symptom after the `display:true` correction was:

- first launch of a session with `resources_discover` durable output: the durable notification persisted, but was **not visible live**
- resuming the same session later: the prior durable notification became visible during replay
- each later resume showed one more prior startup notification

A red seam test plus re-reading the Pi extension API docs located the deeper cause.

Pi's extension API exposes `custom_message` live delivery through `pi.sendMessage(...)`. The docs for `pi.registerMessageRenderer(...)` describe that renderer path together with `pi.sendMessage(...)`. Direct `ctx.sessionManager.appendCustomMessageEntry(...)` persists a custom message into the session file, but does not itself use the live custom-message delivery path.

So direct `appendCustomMessageEntry(...)` writes can produce exactly the replay-only symptom above:

- the entry exists in session storage immediately
- the entry becomes visible on later session replay
- but the operator does not see it at the time it is first written

The accepted architecture remains sound:

- split output across **ephemeral** and **durable** seams
- keep helper scripts able to reach both seams, while runtime-owned output can choose the seam that fits its signal level

The bug is narrower: ADR 0004, ADR 0005, and the initial version of ADR 0006 recorded the wrong live-delivery contract for the operator-visible durable `custom_message` path.

## Decision

For `pi-hooks`, any durable `custom_message` entry that is intended to be **operator-visible inline in the interactive transcript/TUI on first delivery** must:

1. be delivered through `pi.sendMessage(...)`
2. use `display:true` on that `custom_message`

Do **not** write operator-visible durable `custom_message` entries directly through `ctx.sessionManager.appendCustomMessageEntry(...)`.

Direct `appendCustomMessageEntry(...)` writes remain a persistence primitive, but they are not the correct live-delivery seam for operator-visible `custom_message` entries in Pi.

Apply this correction to any operator-visible durable custom-message entry that should appear inline on first delivery.

In the current implementation, that means the helper-script durable message type:

1. `pi-hooks-hook-notify`
   - the ADR 0005 helper-script durable operator-notify entry emitted from `PI_HOOK_MSG:`

This ADR does **not** change the broader architecture.

The following remain unchanged:

- the split between **ephemeral** and **durable** output
- the split between **internal runtime output** and **helper-script output**
- `PI_HOOK_NOTIFY:` as the ephemeral helper-script prefix
- `PI_HOOK_MSG:` as the durable helper-script prefix
- `ctx.ui.notify(...)` as the ephemeral seam
- `ctx.ui.setStatus(...)` as the lightweight in-flight status seam
- the choice of a durable operator-visible `custom_message` seam for these operator-visible log entries

What changes is the required **live-delivery API plus display flag** for that operator-visible durable `custom_message` channel.

`ctx.sessionManager.appendCustomMessageEntry(...)` remains available for persisted custom-message writes that are **not** intended to appear live inline in the interactive transcript.

## Superseded prior decisions

This ADR partially supersedes ADR 0004, ADR 0005, and the earlier accepted form of ADR 0006 on narrow points only:

- the claim that `appendCustomMessageEntry(..., display:false)` plus `registerMessageRenderer(...)` yields operator-visible inline transcript rendering in interactive Pi
- the narrower follow-up claim that correcting only `display:false` -> `display:true` is sufficient for first-run operator-visible delivery of durable `custom_message` entries

Those claims are false against the shipped Pi implementation and extension API behavior.

This ADR does **not** supersede:

- ADR 0004's seam split
- ADR 0005's introduction of `PI_HOOK_MSG:`
- the accepted distinction between ephemeral and durable output
- the accepted distinction between runtime-owned and helper-script-owned output

## Rationale

### Why correct the live-delivery seam instead of revisiting the architecture?

Because the architecture was not what failed.

What failed was a narrower assumption about how Pi delivers and renders `custom_message` entries in the interactive TUI. The persistence behavior shipped exactly as designed; the first-run live visibility behavior did not, because the accepted ADRs recorded the wrong live-delivery and display contract.

### Why keep this correction after removing `pi-hooks-hook-run`?

Because the underlying Pi contract did not change.

Helper-script durable output still uses operator-visible `custom_message` delivery, and any future runtime-owned durable custom message would hit the same live-delivery/display rule. Removing routine runtime completion summaries narrows the current scope of this ADR, but does not invalidate the contract it records.

### Why keep the `custom_message` seam rather than switching to `appendCustomEntry(...)`?

Because the agreed architecture already chose durable operator-visible **custom messages** as the operator-history seam for these outputs, and helper-script output already targets that seam through `PI_HOOK_MSG:`.

This ADR corrects the live-delivery and display contract of that seam; it does not replace it with a different persistence primitive.

## Consequences

### Positive

- durable helper-script output from `PI_HOOK_MSG:` becomes interactively visible on first delivery where ADR 0005 said it would be visible
- replay behavior and first-run live behavior now align on the same operator-visible custom-message path
- the accepted architecture stays intact; only the mistaken live-delivery and display contract is corrected
- the repo's decision record becomes truthful again about how Pi actually delivers and renders custom messages

### Negative / costs

- `display:true` custom messages become part of the interactive transcript flow, so they occupy more visible chat space than hidden persisted entries
- `pi.sendMessage(...)` custom messages are converted into model-visible context by Pi's message-to-LLM conversion path for `role: "custom"`
- future operator-visible durable custom messages must now treat first-run live visibility and model-context cost as linked consequences of using `pi.sendMessage(..., display:true)`

## Non-decisions / unchanged decisions

This ADR does **not** decide:

- whether future Phase 2 work should add richer widget/progress surfaces
- whether some future durable state should move to `appendCustomEntry(...)`
- whether a later policy should distinguish model-visible vs model-hidden durable state more aggressively

Those may become later ADRs if needed. This ADR only corrects the current operator-visible durable `custom_message` contract.

## Implementation notes

- route ADR 0005's `pi-hooks-hook-notify` durable operator-log entry through `pi.sendMessage(...)` with `display:true`
- stop relying on direct `appendCustomMessageEntry(...)` writes for first-run operator-visible delivery of helper-script durable custom messages
- keep the existing custom message renderer for `pi-hooks-hook-notify` unless later UX work justifies richer rendering
- re-run interactive verification specifically against:
  - `resources_discover` / `.pi/pi-hooks/list-pi-resources.mjs`
- confirm both properties for `pi-hooks-hook-notify` after the change:
  - `pi-hooks-hook-notify` entries are delivered live on first run, persist durably to the session JSONL, and remain inline-visible in the interactive transcript/TUI

## References

- `docs/adr/0004-split-pi-hooks-operational-output-across-dedicated-seams.md`
- `docs/adr/0005-extend-durable-operator-log-seam-to-helper-script-output-via-pi-hook-msg.md`
- `docs/decision-maps/pi-hooks-operational-loop.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js`
