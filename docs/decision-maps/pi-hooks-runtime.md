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

`matcher` should remain event-specific at runtime. Pi Hooks should only evaluate a matcher against a single, obvious string subject when the Pi event exposes one. Otherwise the event is match-all only and any configured matcher should be warned about and ignored.

Runtime matcher subjects for the first slice:

- `tool_call` → `event.toolName`
- `tool_result` → `event.toolName`
- `tool_execution_start` → `event.toolName`
- `tool_execution_update` → `event.toolName`
- `tool_execution_end` → `event.toolName`
- `user_bash` → `event.command`
- `input` → `event.text`
- `before_agent_start` → `event.prompt`

All currently schema-defined events are runtime-supported in the first slice, but every event not listed above is match-all only.

That means those events should ignore configured matchers with a warning rather than inventing ad hoc subjects such as cwd, session reason, status code, or serialized payload blobs.

Rationale:

- Pi-native tool events already expose a stable string subject: `toolName`
- Pi-native input events already expose a stable string subject: `text` / `prompt`
- many lifecycle events are notifications, not natural matcher targets
- keeping unsupported events as match-all only avoids a fake generality that would be hard to document and reason about later

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

For Pi Hooks v1:

- command hooks may observe lifecycle events
- command hooks may succeed, fail, timeout, and emit diagnostics
- command hooks may **not** block Pi flow
- command hooks may **not** mutate input, tool arguments, tool results, or provider payloads
- command hooks may **not** replace Pi-native approval/trust behavior

Why this is the right Pi-native first slice:

- Pi already has a safe, explicit path for blocking/mutation: handwritten TypeScript extensions
- `hooks.json` currently defines command handlers, not a structured bidirectional control protocol
- observe-only keeps the first runtime layer vertically thin and easy to verify
- future blocking/mutation support can be added only after defining a deliberate machine-readable command protocol

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
- command hooks in Pi Hooks v1 remain observe-only and therefore do not replace either of those native pathways

Codex’s `PermissionRequest` hooks are useful reference for where policy hooks may matter, but Pi already exposes the relevant lifecycle seams differently. Pi Hooks should map onto those existing Pi events rather than create a parallel approval abstraction.
