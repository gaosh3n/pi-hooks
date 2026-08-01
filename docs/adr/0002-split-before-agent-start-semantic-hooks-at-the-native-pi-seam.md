# 2. Split before_agent_start semantic hooks at the native Pi seam

Date: 2026-08-01

## Status

Accepted

## Context

Issue [#19](https://github.com/gaosh3n/pi-hooks/issues/19) requires semantic `before_agent_start` hooks whose valid outputs may:

- inject one Pi-native `message`
- replace `systemPrompt`
- do both in one valid output
- compose in configured order
- let later hooks see the latest chained `systemPrompt`
- warn and fail open on malformed or unsupported stdout

The current Pi Hooks implementation satisfies the `systemPrompt` part, but not the multi-message part in a fully Pi-native way.

Today Pi Hooks registers **one** native `before_agent_start` handler and loops through many command hooks inside that handler. That internal loop can accumulate many messages, but the public Pi seam for one handler result is only:

- `message?`
- `systemPrompt?`

So the current implementation returns the last message natively and emits earlier messages through `pi.sendMessage(...)`.

That is a real semantic mismatch:

- earlier messages do not travel through the same native turn-setup result path
- ordering/timing/side-effects differ from true native `before_agent_start` aggregation
- the code review for issue #19 correctly treats this as a blocker

Pi itself is not the limitation. Pi’s extension runtime already supports:

- multiple handlers for the same event from one extension
- registration-order execution
- chained `systemPrompt` updates across handlers
- aggregation of returned `message` values across handlers for the same turn

So the mismatch is architectural: Pi Hooks collapses too much **before** reaching the native Pi seam.

## Decision

For `before_agent_start`, Pi Hooks will stop collapsing all matching command hooks into one native handler result.

Instead, Pi Hooks will preserve its current discovery and matching model, but it will project matching `before_agent_start` command hooks onto **multiple native handler-level contributions** so Pi’s own runner performs message aggregation and `systemPrompt` chaining.

Concretely:

1. Keep the existing hook discovery, file precedence, matcher normalization, and per-hook command execution semantics.
2. Introduce an internal compiled representation for `before_agent_start` semantic hook slots in configured order.
3. Register multiple native `before_agent_start` handlers, one slot per possible semantic contribution position.
4. Each slot handler will:
   - look up the current session’s compiled slot at its index
   - no-op when that slot does not exist for the current registry
   - re-check matcher applicability for the current event prompt
   - run exactly one command hook
   - validate stdout against the exact issue-#19 `before_agent_start` output contract
   - return one native `BeforeAgentStartEventResult | undefined`
5. The slot handler will never call `pi.sendMessage(...)` to fake earlier messages.
6. Message aggregation and latest-`systemPrompt` chaining are delegated back to Pi’s native `before_agent_start` runner.

### Chosen seam

The external seam remains the Pi extension API.

The new internal seam is a compiled **before-agent-start semantic slot table**. Callers/tests should not care how many hooks/files/matcher groups produced that table; they should only observe Pi-native ordered handler contributions at the event seam.

### Why this shape

This is the smallest design that restores locality and spec fidelity without rewriting the whole registry system.

It keeps deep logic inside Pi Hooks:

- discovery precedence
- matcher selection
- hooks.json validation
- command execution
- stdout parsing
- fail-open warning policy

But it stops Pi Hooks from owning the one behavior Pi already knows how to do better: aggregating multiple native `before_agent_start` contributions for the same turn.

### Scope

This ADR is specific to `before_agent_start`.

Other semantic-output events may later deserve their own seam decisions. In particular, `input` has different terminal semantics (`continue` / `transform` / `handled`) and should not be forced into the same design without a separate decision.

## Consequences

### Easier

- Issue #19 can be implemented in a way that matches the spec literally.
- Multiple injected messages will use the same native turn-setup path.
- Ordering and latest-`systemPrompt` chaining become Pi-owned behavior at the seam.
- Tests can assert true native composition instead of a `sendMessage(...)` compromise.
- The gap identified in `dist/issue-19-code-review.md` is removed by construction.

### Harder

- Pi’s API exposes `on(...)` but not per-handler unregister, so Pi Hooks must manage a stable handler-slot strategy safely across session changes.
- The compiled slot table becomes new internal state that must stay aligned with the active registry.
- We must avoid handler accumulation bugs, stale slot execution, and duplicate semantic effects across session transitions.

### Risks to mitigate

- **Stale-slot risk:** previously registered slot handlers must no-op against the current compiled slot table when their index is no longer active.
- **Growth risk:** if handlers are allocated lazily by max slot count ever seen, tests must prove old slots do not leak behavior into later sessions.
- **Ordering risk:** compiled slot order must remain exactly consistent with current discovery/file/matcher-group/hook order.
- **Parity risk:** fail-open warnings and stdout validation must remain identical to the current single-dispatch implementation.

### Implementation direction

A good first implementation is a **slot-indexed fanout**:

- on `session_start`, compile the current ordered `before_agent_start` hook slots from `activeRegistry`
- maintain that compiled slot table in mutable runtime state
- ensure native `before_agent_start` handlers exist for slot indices `0..N-1`
- each registered native handler reads the current slot at its own index and returns one contribution or `undefined`

This avoids dynamic handler teardown while still restoring native Pi aggregation.

### Non-decision

This ADR does **not** decide:

- whether other semantic events should use the same pattern
- whether hook compilation should later become a shared module across semantic events
- whether the public hooks.json model should change

Those remain separate design questions.
