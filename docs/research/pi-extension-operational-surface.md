# Pi extension UI and operational surfaces

## Question

What operator-facing surfaces does Pi expose to extensions, based on inspected Pi documentation, bundled examples, and installed package source?

## Sources inspected

- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/status-line.ts`
- `/opt/homebrew/Cellar/pi-coding-agent/0.83.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/ssh.ts`

## Findings

### 1. Extensions can set footer/status text

The inspected Pi extension docs expose a UI status API via `ctx.ui.setStatus(key, text)`.

This provides:

- a keyed status entry
- text shown in the footer/status area
- explicit clearing by setting an empty string

The bundled `examples/extensions/status-line.ts` demonstrates this surface in use.

### 2. Extensions can render richer footer widgets

The inspected Pi extension docs also expose `ctx.ui.setWidget(key, widget)`.

This allows an extension to replace a plain status line entry with a structured widget in the same general footer/status area.

### 3. Extensions can send transient notifications

The inspected Pi extension docs expose `ctx.ui.notify(text, level)`.

The documented/observed levels include:

- `info`
- `warning`
- `error`

This is a built-in operator-facing notification surface distinct from the footer/status line.

### 4. Extensions can register slash commands

The inspected Pi extension docs expose `pi.registerCommand(...)`.

This gives extensions a command entry point that can be invoked from Pi.

### 5. Extensions can control a working indicator

The inspected Pi extension docs expose `ctx.ui.setWorkingIndicator(...)`.

This is a separate built-in UI primitive for marking work/progress state.

### 6. Extensions have session-scoped event handlers and context

The inspected extension docs and examples show event-driven extension hooks such as session and message lifecycle handlers, with a `ctx` object carrying UI access for the current extension context.

### 7. Hidden extension-authored assistant steering/messages are a separate surface

The inspected extension docs describe internal/hidden assistant steering surfaces such as `deliverAs: "steer"` for injected messages. This is separate from footer status and transient notifications.

## Non-findings from the inspected sources

The inspected docs/examples did **not** clearly document the following as first-class extension primitives:

### 1. A built-in task/run timeline for extension-owned subprocesses

No clearly documented built-in extension API was found for showing a persistent per-task timeline/history of extension-managed subprocesses or runs.

### 2. A documented custom event bus for extension-defined operator events

No clearly documented extension API was found for emitting arbitrary custom UI events into Pi's native event stream.

### 3. A documented dedicated hook-observability framework

No clearly documented Pi-native subsystem was found specifically for hook/run observability as a distinct extension feature area.

## Bottom line

From the inspected Pi docs/examples, the main documented operator-facing extension surfaces are:

- footer/status text via `ctx.ui.setStatus(...)`
- richer footer widgets via `ctx.ui.setWidget(...)`
- transient notifications via `ctx.ui.notify(...)`
- command entry points via `pi.registerCommand(...)`
- working/progress indication via `ctx.ui.setWorkingIndicator(...)`
- hidden/internal steering-style message delivery as a separate surface

The inspected sources do not clearly document a first-class built-in timeline/event-stream UI for extension-owned operational telemetry.