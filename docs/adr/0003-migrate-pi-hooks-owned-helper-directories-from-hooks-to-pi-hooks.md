# 3. Migrate Pi Hooks-owned helper directories from `hooks` to `pi-hooks`

Date: 2026-08-11

## Status

Accepted

## Context

Pi 0.83 treats a `.pi/hooks/` directory as a deprecated Pi-native extension location and warns at startup that hooks have been renamed to extensions.

Pi Hooks also uses the name `hooks` inside `.pi` for its own helper-script directories. In practice, users may place Pi Hooks-owned assets in either:

- `~/.pi/hooks/`
- `<project>/.pi/hooks/`

and then reference those assets from `hooks.json` commands such as `.pi/hooks/some-script.sh`.

That creates a namespace collision at the Pi config root:

- Pi-native startup migration logic interprets `.pi/hooks/` as an extension-layout signal
- Pi Hooks interprets `.pi/hooks/` as its own helper-asset directory

The result is misleading startup warnings that appear even when the warning is unrelated to whether the Pi Hooks extension is loaded.

This is an architectural naming conflict, not merely a documentation problem. Pi Hooks needs a durable directory name for its own assets that does not collide with Pi-native extension layout.

## Decision

Pi Hooks-owned helper assets under `.pi` will move from `hooks/` to `pi-hooks/`.

This applies uniformly at both supported scopes:

- user-level: `~/.pi/pi-hooks/`
- project-level: `<project>/.pi/pi-hooks/`

### Scope of this decision

This ADR covers the directory name used for Pi Hooks-owned helper assets only.

It does **not** rename the Pi Hooks config file or discovery contract. For now, Pi Hooks configuration remains:

- user-level: `~/.pi/hooks.json`
- project-level: `<project>/.pi/hooks.json`

### Resulting naming rule

Within a `.pi` directory:

- `hooks.json` remains the Pi Hooks config file
- `pi-hooks/` is the Pi Hooks-owned helper-asset directory
- `hooks/` is no longer a valid long-term Pi Hooks-owned helper directory name

### Migration intent

All Pi Hooks documentation, examples, generated scaffolding, and repo-local helper command paths should prefer `pi-hooks/` over `hooks/`.

If temporary compatibility with legacy `.pi/hooks/` is provided during rollout, that compatibility is a migration aid rather than the documented steady-state architecture.

## Consequences

### Easier

- Avoids collision with Pi-native extension migration behavior under `.pi/hooks/`
- Eliminates misleading startup warnings caused by Pi Hooks-owned helper directories
- Makes the boundary clearer between Pi-native extension layout and Pi Hooks-owned assets
- Gives docs and examples one unambiguous directory convention at both global and project scope

### Harder

- Existing examples, tests, fixtures, and local setups that reference `.pi/hooks/` helper assets must be updated
- Users with existing helper assets under `.pi/hooks/` need migration guidance or temporary compatibility handling
- We must communicate clearly that `hooks.json` remains unchanged while the helper directory name changes

### Non-decisions

This ADR does **not** decide:

- whether `hooks.json` should ever be renamed
- whether migration should be automatic, warned, or fail-open at runtime
- how long any legacy `.pi/hooks/` compatibility should remain

Those are rollout and implementation questions to decide separately.