# Codex hooks findings for `pi-hooks`

This note consolidates the former `codex-hooks-merge.showboat.md` research into one place.

## Sources inspected

`root-directory` represents the root directory of Codex source code.

- `<root-directory>/codex-rs/config/src/hook_config.rs`
- `<root-directory>/codex-rs/hooks/src/engine/discovery.rs`
- `<root-directory>/codex-rs/hooks/src/config_rules.rs`
- `<root-directory>/codex-rs/hooks/src/events/common.rs`
- `<root-directory>/codex-rs/hooks/src/events/pre_tool_use.rs`
- `<root-directory>/codex-rs/hooks/src/events/post_tool_use.rs`
- `<root-directory>/codex-rs/core/src/hook_runtime.rs`
- `<root-directory>/codex-rs/core/src/session/mod.rs`
- `<root-directory>/codex-rs/core/src/config/config_loader_tests.rs`
- Pi docs: `docs/extensions.md`

## Discovery / merge order

Codex discovers hooks in `discover_handlers()`:

- processes config layers in `LowestPrecedenceFirst` order
- remembers visited hook folders in `visited_json_hook_folders`
- loads `hooks.json` at most once per folder
- loads TOML hooks from the layer separately
- appends both sources into one discovered handler stream

Key source excerpt:

```rust
for layer in config_layer_stack.get_layers(
    ConfigLayerStackOrdering::LowestPrecedenceFirst,
    /*include_disabled*/ false,
) {
    let json_hooks = match layer.hooks_config_folder() {
        Some(config_folder) if visited_json_hook_folders.insert(config_folder.clone()) => {
            load_hooks_json(Some(config_folder.as_path()), &mut warnings)
        }
        _ => None,
    };
    let toml_hooks = load_toml_hooks_from_layer(layer, &mut warnings);

    for (source_path, hook_events) in [json_hooks, toml_hooks].into_iter().flatten() {
        append_hook_events(/* ... */);
    }
}
```

## `hooks.json` loading

Codex loads `hooks.json` as a strict JSON file, parses it into `HooksFile`, and returns only the `hooks` payload.

```rust
fn load_hooks_json(
    config_folder: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Option<(AbsolutePathBuf, HookEventsToml)> {
    let source_path = config_folder?.join("hooks.json");
    if !source_path.as_path().is_file() {
        return None;
    }

    let contents = fs::read_to_string(source_path.as_path()).ok()?;
    let parsed: HooksFile = serde_json::from_str(&contents).ok()?;
    (!parsed.hooks.is_empty()).then_some((source_path, parsed.hooks))
}
```

## Post-discovery normalization

Codex does not execute raw JSON objects directly. It normalizes each handler into in-memory records while preserving source order.

Normalization happens in `append_matcher_groups()`:

- iterate events in fixed event order
- iterate matcher groups in file order
- iterate handlers in group order
- normalize command fields
- compute a stable positional key
- compute display order
- append a list entry for inspection
- append an executable handler for runtime

```rust
let normalized_handler = HookHandlerConfig::Command {
    command: command.clone(),
    command_windows: None,
    timeout_sec: Some(timeout_sec),
    r#async,
    status_message: status_message.clone(),
};
let key = crate::hook_key(&source.key_source, event_name, group_index, handler_index);

hook_entries.push(HookListEntry { /* ... */ });
handlers.push(ConfiguredHandler {
    event_name,
    matcher: matcher.map(ToOwned::to_owned),
    command,
    timeout_sec,
    status_message,
    source_path: source.path.clone(),
    source: source.source,
    display_order: *display_order,
    env: source.env.clone(),
});
```

Loader-time filtering / normalization includes:

- `commandWindows` overrides `command` on Windows
- unsupported async hooks are skipped
- empty commands are skipped
- timeout is normalized
- env placeholders are substituted
- matcher validity is checked before appending

Codex also creates a parallel inspection record, `HookListEntry`, so the system can list discovered hooks separately from the subset that will actually execute.

## Runtime boundary

`ClaudeHooksEngine::new()` calls discovery once and stores the normalized handlers in memory:

```rust
let discovered = discovery::discover_handlers(
    config_layer_stack,
    plugin_hook_sources,
    plugin_hook_load_warnings,
    bypass_hook_trust,
);
Self {
    handlers: discovered.handlers,
    warnings: discovered.warnings,
    shell,
    output_spiller: HookOutputSpiller::new(),
}
```

After that, runtime selection is separate:

- `select_handlers()` filters the in-memory registry by event name + matcher
- `execute_handlers()` runs selected handlers
- results are returned in configured order even if execution completes out of order

## What Codex validates

- `hooks.json` has strict top-level shape: optional `description`, required `hooks`, no root-level event keys.
- Event keys are fixed and currently use Codex event names like `PreToolUse`, `PostToolUse`, `SessionStart`.
- Handler variants in the data model are `command`, `prompt`, and `agent`, but runtime only executes `command`; `prompt` and `agent` are discovered then skipped with warnings.
- Empty commands are skipped with warnings.
- Unsupported async hooks are skipped with warnings; only `SessionEnd` has special async handling.
- Matchers are event-specific. Some events ignore matchers entirely.
- Matchers support:
    - omitted / `""` / `"*"` => match all
    - plain literals like `Bash`
    - pipe-separated exact alternatives like `Edit|Write`
    - full regex when regex metacharacters are present
- Invalid regexes are warned and skipped only for matcher-capable events.
- Timeouts are normalized at load time, not just schema time.

## Codex matcher-pattern semantics

Codex's matcher logic lives in `<root-directory>/codex-rs/hooks/src/events/common.rs`.

Two helpers matter:

- `validate_matcher_pattern(matcher)`
- `matches_matcher(matcher, input)`

The behavior is:

- omitted matcher (`None`) => match all
- `""` => match all
- `"*"` => match all
- exact matchers are matched by string equality, not regex substring matching
- `|` inside an exact matcher means exact alternatives, e.g. `Edit|Write`
- only patterns that are not match-all and not exact are compiled as regex

Key source excerpt:

```rust
pub(crate) fn validate_matcher_pattern(matcher: &str) -> Result<(), regex::Error> {
    if is_match_all_matcher(matcher) || is_exact_matcher(matcher) {
        return Ok(());
    }
    regex::Regex::new(matcher).map(|_| ())
}

pub(crate) fn matches_matcher(matcher: Option<&str>, input: Option<&str>) -> bool {
    match matcher {
        None => true,
        Some(matcher) if is_match_all_matcher(matcher) => true,
        Some(matcher) if is_exact_matcher(matcher) => input
            .map(|input| matcher.split('|').any(|candidate| candidate == input))
            .unwrap_or(false),
        Some(matcher) => input
            .and_then(|input| regex::Regex::new(matcher).ok().map(|regex| regex.is_match(input)))
            .unwrap_or(false),
    }
}
```

Important implication: Codex does **not** treat every matcher as regex. It has a three-way classification:

1. match-all
2. exact literal / exact alternatives
3. regex

This is why `Bash` matches only `Bash`, while `Edit|Write` matches either exact tool name, and `^Bash(Output)?$` is treated as regex.

## Codex matcher coverage by event

Codex also makes matcher coverage event-specific via `matcher_pattern_for_event(event_name, matcher)`.

- matcher-capable events include `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, and `PostCompact`
- `UserPromptSubmit` and `Stop` ignore matchers entirely and force `None`

So Codex has two separate questions:

1. does this event even use a matcher?
2. if it does, is the matcher match-all, exact, or regex?

## Codex tool coverage for literal matchers

For tool-related events, Codex literal matcher examples in docs often use built-in tool names like `Bash`, `Edit`, and `Write`, but the source/tests show that the exact-matcher path is not limited to only those names.

For example, `common.rs` tests exact matching for an MCP tool name:

```rust
assert!(matches_matcher(
    Some("mcp__memory__create_entities"),
    Some("mcp__memory__create_entities")
));
assert!(!matches_matcher(
    Some("mcp__memory"),
    Some("mcp__memory__create_entities")
));
```

That means the Codex rule is really syntax-based exact matching, not "only a fixed enum of built-in tools." Built-in tool names are just the easiest examples to document.

## Pi-native tool coverage to mirror, not copy

Pi should not copy Codex tool-name examples blindly. Pi has its own tool vocabulary.

From Pi's installed docs and type declarations:

- built-in `tool_call` names are:
    - `bash`
    - `read`
    - `edit`
    - `write`
    - `grep`
    - `find`
    - `ls`
- Pi also supports custom tools registered through `pi.registerTool({ name: string, ... })`
- `CustomToolCallEvent` therefore uses `toolName: string`, not a closed literal union

Key Pi type excerpt:

```ts
export interface BashToolCallEvent extends ToolCallEventBase {
    toolName: "bash";
    input: BashToolInput;
}
// ... read/edit/write/grep/find/ls omitted ...
export interface CustomToolCallEvent extends ToolCallEventBase {
    toolName: string;
    input: Record<string, unknown>;
}
```

And Pi docs explicitly describe `tool_call` examples with `event.toolName - "bash", "read", "write", "edit", etc.` plus custom tools typed via `isToolCallEventType<"my_tool", ...>("my_tool", event)`.

Implication for Pi Hooks:

- examples for `tool_call` matcher semantics should use Pi-native tool names like `read`, `edit|write`, or custom names like `my_tool`
- the loader should not assume a closed Codex-style whitelist of literal values
- plain literals must be classified by syntax, then preserved for later exact matching against Pi's actual tool names

## How Codex loads hooks

- Hook discovery is gated by a feature flag.
- It reads `hooks.json` from the config folder associated with each config layer.
- User/global hooks live beside user `config.toml`.
- Project hooks live in project `.codex/` folders.
- Config layers are processed in **lowest-precedence-first** order.
- Handlers are **appended**, not deep-merged by key.
- Within a single config layer, if both `hooks.json` and TOML hook declarations exist, Codex warns and then loads both in this order:
    1. `hooks.json`
    2. TOML `hooks`
- If multiple config layers share the same hooks folder, `hooks.json` from that folder is loaded only once.
- Hook state (`enabled`, `trusted_hash`) is not stored in project files; effective state is read only from user/session config layers.

A concrete proof point is `core/tests/suite/hooks.rs::pre_tool_use_merges_hooks_json_and_config_toml()`, plus `hooks/src/engine/discovery.rs`, which shows the append order and the per-folder `visited_json_hook_folders` dedup.

## Implication for Pi Hooks

For Pi Hooks, the Codex pattern to copy is:

1. discover config files in deterministic order
2. parse each `hooks.json`
3. normalize all handlers once into an in-memory registry
4. preserve configured order
5. keep runtime event dispatch separate from config loading

Pi should simplify by omitting TOML hook loading entirely.

### Pi adaptation

- Keep `hooks.json` strict and JSON-only.
- Use `pi-hooks.schema.json` as the canonical file-shape validator.
- Load global `~/.pi/hooks.json` first, then project-local `.pi/hooks.json` files from root to leaf.
- Append all discovered handlers in deterministic order.
- Deduplicate only by exact file path so the same file is not loaded twice.
- Normalize each discovered handler once into an in-memory registry.
- Keep loader concerns separate from any later runtime dispatch concerns.
- Treat a malformed `hooks.json` as a startup warning that skips the whole file.
- Treat partially invalid handlers inside a valid file as per-entry warnings that skip only the bad entries.
