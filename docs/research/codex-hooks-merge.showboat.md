# Codex hooks merge investigation

## Scope

This note records the Codex source findings relevant to Pi Hooks loading semantics.

## Findings

### Discovery / merge order

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

### `hooks.json` loading

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

### Post-discovery normalization

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

### Loader-time filtering / normalization

While normalizing, Codex also applies loader-time rules:

- `commandWindows` overrides `command` on Windows
- unsupported async hooks are skipped
- empty commands are skipped
- timeout is normalized
- env placeholders are substituted
- matcher validity is checked before appending

### Runtime boundary

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

## Implication for Pi Hooks

For Pi Hooks, the Codex pattern to copy is:

1. discover config files in deterministic order
2. parse each `hooks.json`
3. normalize all handlers once into an in-memory registry
4. preserve configured order
5. keep runtime event dispatch separate from config loading

Pi should simplify by omitting TOML hook loading entirely.
