# Pi extension operational surface for hook observability

## Question

What operator-facing surfaces does Pi already expose to extensions, and how do those constrain a first Pi Hooks operational loop?

## Sources inspected

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/status-line.ts`
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/working-indicator.ts`
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/README.md`
- `src/index.ts`

## What Pi already gives extensions

### 1. Footer status text

Pi exposes `ctx.ui.setStatus(key, text)` for persistent footer status.

The docs and examples show:

- keyed ownership (`setStatus("my-ext", ...)`)
- clearing with `undefined`
- updates from ordinary event handlers such as `session_start`, `turn_start`, `turn_end`, and `model_select`

This is the lightest-weight built-in operator surface for “a hook is running” or “hook run failed”.

### 2. Widgets

Pi exposes `ctx.ui.setWidget(key, widget)` for richer persistent visual state above or below the editor.

Docs/examples show it can render:

- simple string arrays
- custom TUI components
- above-editor or below-editor placement

This is a viable second-step inspection surface for recent hook runs or latest failures.

### 3. Notifications

Pi exposes `ctx.ui.notify(text, level)` for transient notices.

That is useful for exceptional hook outcomes such as:

- timeout
- non-zero exit
- malformed stdout on a semantic hook

But it is too noisy to use for every routine hook completion.

### 4. Commands

Pi exposes `pi.registerCommand(...)` for extension-owned commands.

That means Pi Hooks can add an inspection surface such as:

- `/hooks`
- `/hooks recent`
- `/hooks failures`

without needing Pi core changes.

### 5. Streaming working indicator customization

Pi exposes `ctx.ui.setWorkingIndicator(...)`.

This controls the agent-streaming spinner, not arbitrary sub-process job telemetry. It may still be useful later, but it is not a substitute for hook-specific status state.

### 6. Session-scoped extension state is normal

Pi docs explicitly support session-scoped runtime state that is created on `session_start` and cleaned up on `session_shutdown`.

That matches Pi Hooks’ current runtime shape and gives a natural home for:

- active hook runs
- recent hook runs buffer
- current aggregated status text

## What Pi does not obviously give extensions

### 1. No documented extension-defined event stream into RPC clients

`rpc.md` documents built-in streamed events such as:

- `agent_start`
- `turn_start`
- `message_update`
- `tool_execution_*`
- `extension_error`

But the docs shown do not describe an API for extensions to emit arbitrary custom protocol events like `hook_started` / `hook_completed` into that stream.

So the safest assumption is:

- extension-owned hook telemetry can be shown in TUI now
- RPC inspection likely needs to happen through commands or existing UI surfaces unless deeper Pi support is found later

### 2. No built-in hook-run timeline primitive

Pi offers status lines, widgets, notifications, and commands, but not a first-class generic “background task timeline” primitive for extension subprocesses.

So Pi Hooks must own its own run model and presentation logic.

## What Pi Hooks already has locally

From `src/index.ts`, Pi Hooks already has the runtime substrate needed to back an operational loop:

- `LoadedHook.statusMessage?: string`
- `activeHookExecutions: Set<ActiveHookExecution>`
- cancellation reasons: `abort | shutdown | timeout`
- a single child-process runner `runCommandHook(...)`
- stdout/stderr capture
- semantic vs observe-only dispatch seams
- `session_shutdown` cleanup path

But the current tracked state is process-control-only, not operator-facing:

- `activeHookExecutions` does not carry ids, source metadata, timestamps, or entries
- warnings go straight to `console.warn(...)`
- `statusMessage` is loaded but never surfaced via `ctx.ui.setStatus(...)`
- observe-only hooks are operationally invisible except for late warnings

## Implications for Pi Hooks

### Best first UI surface: footer status

Because Pi already has keyed footer status and examples for event-driven updates, the lowest-risk first operational surface is:

- aggregate active hook runs
- render one compact status line
- clear it when no runs are active

### Best first inspection surface: command, not protocol

Because Pi definitely supports commands and does not obviously support arbitrary extension event streaming, the safest first inspection surface is an extension command such as `/hooks`.

### Widgets are a second-step enhancement

A widget can later show:

- most recent failures
- currently active hooks
- last N runs with status/duration

But it is not necessary for the first proving slice.

### Notifications should be exceptional only

`ctx.ui.notify(...)` should likely be reserved for:

- hook timeout
- hook spawn/exit failure
- malformed semantic stdout on a semantic event

Routine successful completions should not notify.

## Bottom line

Pi already gives enough extension-owned UI to build a useful first operational loop for Pi Hooks:

- `setStatus` for “running now”
- `registerCommand` for inspection
- optional `setWidget` for richer recent-run display
- `notify` for exceptional failures

The missing piece is not Pi UI capability. The missing piece is an internal Pi Hooks hook-run model that those surfaces can read from.
