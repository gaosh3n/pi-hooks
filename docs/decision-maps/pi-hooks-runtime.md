# Pi Hooks: runtime, execution engine, and lifecycle

## #1: Are Pi Hooks runtime call sites and lifecycle seams already Pi-native?

Type: Research

### Question

Does Pi already expose the runtime/lifecycle seams we need for hooks, or do we need to invent Codex-style call sites inside Pi Hooks itself?

### Answer

Resolved. Pi already exposes most of the needed seams natively through extension events. See:

- `docs/research/codex-hooks-findings.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.80.6/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

Useful Pi-native seams already exist for:

- session lifecycle: `project_trust`, `session_start`, `session_shutdown`
- conversation lifecycle: `input`, `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`
- tool lifecycle: `tool_execution_start`, `tool_call`, `tool_result`, `tool_execution_end`
- provider/model lifecycle: `before_provider_headers`, `before_provider_request`, `after_provider_response`, `model_select`, `thinking_level_select`

So Pi Hooks does **not** need to invent a new runtime host like Codex’s `hook_runtime.rs` just to observe Pi lifecycle events.

What Pi does **not** provide natively is a declarative `hooks.json` command-runner. That adapter layer still belongs to Pi Hooks.

## #2: What does `matcher` mean at runtime for each Pi event?

Blocked by: #1
Type: Discuss

### Question

For each supported Pi event, what concrete event field does a `matcher` evaluate against? Examples: tool name, raw input text, session reason, or nothing at all.

### Answer

Resolved.

`matcher` should remain event-specific at runtime. Pi Hooks should evaluate a matcher against one documented, stable scalar string field when the Pi event exposes one. If an event does not expose that kind of field, the event is match-all only and any configured matcher should be warned about and ignored.

Runtime matcher subjects for the first runtime work:

- `project_trust` → `event.cwd`
- `resources_discover` → `event.reason`
- `session_start` → `event.reason`
- `session_before_switch` → `event.reason`
- `session_before_compact` → `event.reason`
- `session_compact` → `event.reason`
- `session_shutdown` → `event.reason`
- `model_select` → `event.source`
- `thinking_level_select` → `event.level`
- `tool_call` → `event.toolName`
- `tool_result` → `event.toolName`
- `tool_execution_start` → `event.toolName`
- `tool_execution_update` → `event.toolName`
- `tool_execution_end` → `event.toolName`
- `user_bash` → `event.command`
- `input` → `event.text`
- `before_agent_start` → `event.prompt`

All currently schema-defined events are runtime-supported in the first runtime work, but every event not listed above is match-all only.

That means Pi Hooks should use Pi-native event-specific subjects such as session reason, selection source, thinking level, tool name, prompt text, input text, bash command, or project cwd when Pi exposes them. Pi Hooks should still warn and ignore configured matchers for events that do not expose a suitable scalar subject, rather than inventing ad hoc subjects from optional fields, numeric fields, object blobs, or serialized payloads.

Rationale:

- Codex also uses event-specific matcher subjects rather than one global rule
- Pi-native session and selection events expose meaningful scalar discriminators such as `reason`, `source`, and `level`
- Pi-native tool and text events expose stable string subjects such as `toolName`, `command`, `text`, and `prompt`
- `project_trust` is naturally about a concrete project cwd, so `event.cwd` is the Pi-native subject there
- events without a documented stable scalar subject should remain match-all only to avoid fake generality that would be hard to document and reason about later

## #3: What is the command-hook execution contract?

Blocked by: #1, #2
Type: Discuss

### Question

When a loaded command hook fires, what process contract does Pi Hooks provide: cwd, environment, stdin payload, timeout handling, stdout/stderr capture, exit-code semantics, and whether command output can influence Pi behavior?

### Answer

Resolved for the first slice.

Pi Hooks must provide its own command-hook execution engine on top of Pi’s native events.

First-slice execution contract:

- **process model**: spawn the configured command as a child process
- **cwd**: use the current Pi session working directory from the extension context
- **observation ordering**: evaluate the matcher and build stdin payload from the event object exactly as Pi presents it at Pi Hooks’ handler invocation point
- **ordering relative to other extensions**: Pi Hooks should not invent its own pre/post snapshot model around handwritten extensions; it observes the current event state when its Pi-native handler runs, and relative ordering remains Pi-native
- **stdin**: send one JSON object describing the fired event, including:
    - `event`: Pi event name
    - `sourcePath`: discovered `hooks.json` path
    - `matcher`: normalized matcher metadata
    - `payload`: event-specific serializable data
- **env**: inherit the parent environment and add Pi-Hooks-specific metadata variables only if needed for ergonomics; stdin JSON remains the canonical machine-readable input
- **stdout/stderr**: capture both for diagnostics; neither is interpreted as a control protocol in the first slice
- **timeout**: honor the configured hook timeout when present; otherwise use the normalized default already established by loading rules
- **cancellation**: wire the Pi event context abort signal through to child-process cancellation when possible
- **exit code semantics**: non-zero exit means the hook failed and should be reported, but should not mutate or block Pi behavior in the first slice

This keeps the execution engine small and Pi-native:

- Pi supplies the lifecycle/event host
- Pi Hooks supplies only the declarative command-runner adapter
- no stdout-based mutation protocol is introduced yet

## #4: Which runtime outcomes are allowed for the first Pi Hooks slice?

Blocked by: #1, #2, #3
Type: Discuss

### Question

In the first runtime slice, are hooks observe-only, or may they also block/mutate Pi-native flows such as `input` and `tool_call`?

### Answer

Resolved.

The first runtime slice should be **observe-only command hooks**.

Pi’s native extension API does support richer behavior in TypeScript handlers:

- `input` can transform or handle input
- `tool_call` can block and mutate arguments in place
- `tool_result` can modify returned content/details

But those capabilities belong to Pi’s native extension handler model, not automatically to declarative `hooks.json` command hooks.

For Pi Hooks in this first runtime work:

- command hooks may observe lifecycle events
- command hooks may succeed, fail, timeout, and emit diagnostics
- command hooks may **not** block Pi flow
- command hooks may **not** mutate input, tool arguments, tool results, or provider payloads
- command hooks may **not** replace Pi-native approval/trust behavior

Why this is the right Pi-native first slice:

- Pi already has a safe, explicit path for blocking/mutation: handwritten TypeScript extensions
- `hooks.json` currently defines command handlers, not a structured bidirectional control protocol
- observe-only keeps the first runtime layer vertically thin and easy to verify
- future blocking/mutation support can be added only after defining a deliberate machine-readable hook input/output contract

## #5: How should the Pi Hooks extension own registry refresh and session-scoped runtime state?

Blocked by: #1
Type: Discuss

### Question

When should the extension load/reload the registry, register listeners, and clean up runtime state across `session_start`, `session_shutdown`, reload, fork, and resume?

### Answer

Resolved.

The Pi Hooks extension should own a simple session-scoped runtime with these lifecycle rules:

- load or refresh the active registry on `session_start`
- treat `session_start.reason = "reload"` as a rebuild of in-memory registry state from discovered files
- do not start long-lived background resources in the extension factory
- command execution should be stateless per event fire, except for the currently active in-memory registry
- register listeners once in the extension factory; refresh only the loaded registry/state on later session starts
- on `session_shutdown`, cancel any in-flight hook processes tied to the current session and clear session-scoped runtime state

For session replacement flows (`new`, `resume`, `fork`), rely on Pi’s native `session_shutdown` → `session_start` sequence rather than inventing custom transition logic.

## #6: Do we need Codex-style permission-request hooks, or should Pi Hooks stay Pi-native here?

Blocked by: #1, #2, #4
Type: Research

### Question

Codex has dedicated permission-request hook call sites. Pi has `project_trust` plus blocking `tool_call`. Do we need a separate Pi Hooks concept here, or should we stay Pi-native and map policy hooks onto existing Pi events?

### Answer

Resolved.

Pi Hooks should stay **Pi-native** here and should **not** introduce a separate Codex-style permission-request event family.

For policy-like use cases:

- trust decisions belong to Pi’s native `project_trust` event
- tool-approval or tool-blocking behavior belongs to Pi’s native `tool_call` event
- command hooks in this first runtime work remain observe-only and therefore do not replace either of those native pathways

Codex’s `PermissionRequest` hooks are useful reference for where policy hooks may matter, but Pi already exposes the relevant lifecycle seams differently. Pi Hooks should map onto those existing Pi events rather than create a parallel approval abstraction.

## #7: Should Pi Hooks stay Pi-native at the event boundary?

Blocked by: none
Type: Discuss

### Question

Should Pi Hooks add a Codex-style compatibility layer of synthetic event names and aliases, or keep selection rooted in Pi-native event names and documented Pi event fields?

### Answer

Resolved. Stay Pi-native.

The existing runtime decisions already commit Pi Hooks to Pi-native event names and Pi-native matcher subjects. The next runtime work should build on that rather than introduce Codex compatibility names, synthetic event families, or alias-only selection behavior. Codex is reference material for architecture and hook I/O shape, not a vocabulary source.

## #8: Should hook stdin stay a generic envelope or become event-specific typed input?

Blocked by: #7
Type: Discuss

### Question

Today Pi Hooks sends a generic JSON envelope with `event`, `sourcePath`, `matcher`, and `payload`. For the next runtime slice, should stdin remain that one generic contract, or should Pi Hooks move toward event-specific input schemas the way Codex does?

### Answer

Resolved.

Pi Hooks should keep a **stable generic envelope** and make only the **`payload` field event-specific**.

That means the hook stdin contract should stay Pi-native and small:

- stable top-level metadata fields such as:
    - `version`
    - `event`
    - `sourcePath`
    - `matcher`
    - `cwd`
- one event-shaped `payload` object containing the serializable Pi event data visible at the dispatch seam

Why this is the right trade-off:

- Pi Hooks already spans many Pi-native events; one stable envelope is easier to document and test than a separate top-level command-input document for every event
- the current runtime already thinks in terms of `event + payload`, so this deepens the existing contract instead of replacing it
- the event boundary still stays typed where it matters, because `payload` remains event-specific
- Codex’s fully per-event top-level input structs are useful reference, but Pi Hooks does not need that much schema surface to stay Pi-native

So Pi Hooks should be **envelope-stable, payload-specific**, not fully untyped and not fully per-event at the top level.

## #9: Should hook stdout remain diagnostic-only or become a structured output channel?

Blocked by: #7, #8
Type: Discuss

### Question

The first runtime slice intentionally ignored stdout/stderr as control channels. For the next runtime slice, should stdout remain non-semantic, or should Pi Hooks define a machine-readable hook output contract that the host parses?

### Answer

Resolved.

Pi Hooks should add an **optional machine-readable hook output contract on stdout**.

The contract should be narrow:

- **stdout** becomes the only semantic return channel for command hooks
- **stderr** remains diagnostic-only
- **empty stdout** means “no effect”
- **non-empty stdout** is interpreted only when it is valid JSON matching the event’s allowed output shape

Why:

- without a structured stdout channel, declarative hooks can never participate in Pi-native control seams and remain permanently observe-only
- Pi already supports rich behavior in handwritten extensions, so if Pi Hooks wants a declarative equivalent it needs a real output contract rather than ad hoc text parsing
- Codex shows that stdin and stdout should be treated as a deliberate bidirectional protocol, not as incidental process I/O

This does not mean every event gets semantic stdout. It means Pi Hooks should establish one explicit output path and then grant event powers selectively.

## #10: If structured hook output exists, which Pi events may consume it first?

Blocked by: #9
Type: Discuss

### Question

Pi native extensions expose asymmetric powers across events (`input`, `tool_call`, `tool_result`, some lifecycle seams, and trust-related seams). Which events, if any, should declarative command hooks be allowed to influence in the first hook I/O slice?

### Answer

Resolved.

The first hook I/O slice should allow structured output only for these Pi-native events:

- `input`
    - continue unchanged
    - transform text/images
    - handle without agent execution
- `before_agent_start`
    - inject a message
    - replace the system prompt for the turn
- `tool_call`
    - block with a reason
    - patch tool input
- `tool_result`
    - patch `content`
    - patch `details`
    - patch `isError`

Everything else remains observe-only for now, including:

- `project_trust`
- all session replacement / compaction / tree events
- `context`
- `before_provider_headers`
- `before_provider_request`
- `after_provider_response`
- message lifecycle events
- match-all-only lifecycle and provider events

Why this first allowlist is the right cut:

- it maps onto Pi-native seams that already have clear, bounded return behavior
- it avoids trust and provider-payload policy surfaces, which are higher risk and harder to make safe in declarative command hooks
- it keeps the first mutating slice vertically small while still covering the highest-value intervention points: user input, pre-tool policy, pre-agent prompt shaping, and post-tool result shaping
- it avoids exposing large object-graph rewrites such as full context or provider payload replacement in the first step

`project_trust` should remain permanently observe-only for command hooks. Trust ownership stays Pi-native and belongs to handwritten extensions, user choice, and Pi’s native trust flow.

## #11: How should Pi Hooks validate and version hook input/output schemas?

Blocked by: #8, #9
Type: Research

### Question

If Pi Hooks adopts richer hook input/output contracts, should it publish event-specific JSON Schemas, keep one generic schema, or use some hybrid approach? How should schema/version drift be managed?

### Answer

Resolved.

Pi Hooks should use a **hybrid schema strategy**:

- keep `pi-hooks.schema.json` focused on `hooks.json` configuration only
- publish one **versioned generic envelope schema** for hook stdin and one for hook stdout
- put event-specific structure in `$defs` keyed by Pi event name
- use the top-level `event` field as the discriminator for selecting the allowed `payload` and output shape

Versioning rule:

- add a required protocol field such as `version: 1` to both stdin and stdout envelopes
- bump that version only for breaking wire changes
- additive event payload fields may stay within the same version when they preserve backward compatibility
- new event-specific output capabilities should be added only when the decision map explicitly grants that event semantic stdout

Why this is the right fit:

- it preserves one stable mental model for hook authors
- it avoids bloating `pi-hooks.schema.json` into both config and runtime-wire responsibilities
- it still gives us event-specific validation where behavior actually diverges
- it fits the repo better than Codex’s fully separate generated schema file per event while preserving the same core idea of typed contracts

## #12: How should malformed or unsupported hook output be handled?

Blocked by: #9, #11
Type: Discuss

### Question

When a command hook prints invalid JSON, valid JSON with unknown fields, or event-forbidden control fields, what should Pi Hooks do: ignore, warn, fail closed, or fail open?

### Answer

Resolved.

Pi Hooks should **fail open and contain the error at the hook boundary**.

Rules:

- invalid JSON stdout => warn and ignore the hook output
- valid JSON with unknown fields => warn and ignore the hook output
- valid JSON with fields unsupported for that event => warn and ignore the hook output
- non-zero exit, spawn failure, timeout, or cancellation => same as today: report hook failure, apply no semantic effect
- previously applied valid effects from earlier hooks stay in force; the malformed hook contributes nothing

This rule applies both to observe-only events and to events with semantic stdout.

Why fail-open is the correct Pi-native policy here:

- Pi already has a stronger handwritten extension pathway for trust-heavy or fail-closed policy enforcement
- `hooks.json` command hooks are child processes with text I/O and are therefore a poor place to promise hard safety guarantees
- the repo has already chosen failure containment over host mutation for hook execution faults
- a malformed command hook should not destabilize session flow, trust flow, or tool execution

Consequence: if a user needs hard fail-closed security semantics, they should use a handwritten TypeScript extension rather than rely on declarative command hooks.

## #13: Do we need a second matcher-selection pass beyond the current normalized registry?

Blocked by: #7
Type: Discuss

### Question

Codex normalizes discovery once, then performs explicit per-event selection from the in-memory registry. Pi Hooks already normalizes matchers at load time. Is any deeper selection layer still needed for the next runtime slice, such as multi-subject matching, alias sets, or event-specific dispatch previews?

### Answer

Resolved.

Pi Hooks does **not** need a new general-purpose matcher-selection architecture.

The right design is:

- keep one normalized in-memory registry built at load time
- keep runtime selection as a lightweight per-event dispatch step over that registry
- allow a dispatch seam to provide one or more Pi-native scalar matcher subjects only when the event truly exposes them
- do **not** introduce Codex-style compatibility aliases, synthetic event families, or a separate matcher DSL

So the runtime may deepen the existing dispatch helpers, but it should not introduce a second major subsystem.

Why:

- Pi Hooks already has the key separation Codex relies on: discovery/normalization first, dispatch later
- unlike Codex, Pi Hooks does not need compatibility-name fan-in across a legacy event vocabulary
- one documented Pi-native scalar subject per event remains the main rule; any future multi-subject case should be an explicit event-specific exception, not a new general capability

## #14: How should multiple valid semantic hook outputs compose for the same fired event?

Blocked by: #9, #10, #11, #12
Type: Discuss

### Question

If more than one selected hook returns valid semantic output for the same fired event, what deterministic composition and precedence rules should Pi Hooks use?

### Answer

Resolved.

Pi Hooks should compose valid semantic outputs in **configured order**, and later semantic hooks should see the **latest semantic state** produced by earlier valid hooks for that same fired event.

This intentionally mirrors Pi-native extension chaining where possible.

General rule:

- semantic-output events are processed sequentially in configured order
- malformed or unsupported output is ignored with a warning, and semantic aggregation continues from the latest valid state
- later hooks see the latest semantic state, not the original event snapshot
- event-terminal outcomes stop further semantic processing for that event

Per-event rules:

- `input`
    - `transform` chains on the latest text/images
    - later hooks see the latest transformed input
    - `handled` is terminal; the first valid `handled` wins and later semantic hooks do not run
    - `continue` preserves the latest state and has no terminal effect
- `before_agent_start`
    - `systemPrompt` replacement chains on the latest system prompt
    - later hooks see the latest system prompt
    - injected messages append in configured order
    - one valid hook may contribute both a message and a system prompt replacement
- `tool_call`
    - tool-input patches chain on the latest patched input
    - later hooks see the latest patched input
    - `block` is terminal; the first valid block wins and later semantic hooks do not run
    - if a block occurs, the tool does not execute; any accumulated patched input is not applied to a real tool run
- `tool_result`
    - patches compose field-by-field on the latest result state
    - later hooks see the latest `content`, `details`, and `isError`
    - omitted fields preserve their current values
    - there is no separate terminal outcome in this first slice

Why:

- this keeps declarative hooks aligned with Pi-native extension semantics instead of inventing a second mental model
- it gives AFK implementers one deterministic rule: configured-order chaining over latest state
- it keeps terminal control points narrow and explicit: `handled` for `input`, `block` for `tool_call`
- it avoids whole-output replacement semantics that would be harder to reason about than fieldwise or statewise chaining
