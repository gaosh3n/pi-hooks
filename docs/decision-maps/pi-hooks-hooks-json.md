# Pi Hooks: validate and load `hooks.json`

## #1: What exactly should `hooks.json` validate?

Type: Research

### Question

What is the canonical Pi Hooks JSON shape, and which validations should happen at load time vs. schema/editor time?

### Answer

Resolved. `pi-hooks.schema.json` is enough for the main structural validation of `hooks.json`.

The settled schema already covers the important shape constraints:

- top level: optional `$schema`, optional `description`, required `hooks`
- no unknown root keys
- known Pi event names only
- `type: "command"` only
- non-empty `command`
- no unknown handler fields

So the ticket answer should be narrower: schema validation is sufficient for **file format validation**.

What may still remain outside schema validation is **loader/runtime validation**, if we choose to enforce it:

- compile `matcher` strings and report invalid regexes cleanly
- normalize/default `timeout`
- optionally reject matcher usage on events where Pi provides nothing meaningful to match against
- validate command-hook stdin/stdout protocol once runtime behavior is implemented

The conclusion is:

- use `pi-hooks.schema.json` as the canonical `hooks.json` validator
- keep any remaining checks limited to runtime concerns, not file-shape concerns

## #2: Where should Pi load `hooks.json` from?

Blocked by: #1
Type: Research

### Question

How should Pi discover hooks files across global/user/project-local layers ?

### Answer

Resolved. See:

- `docs/research/codex-hooks-findings.md`
- `docs/research/codex-hooks-merge.showboat.md`

Codex’s merge behavior is still useful as reference:

- it discovers hook sources in **lowest-precedence-first** order
- it **appends** handlers; it does not deep-merge hook objects by key
- if multiple config layers point at the same hooks folder, `hooks.json` is loaded **once** for that folder

For Pi Hooks, we intentionally simplify further:

- `hooks.json` is the **only** Pi Hooks config format
- `config.toml` does **not** participate in Pi Hooks at all
- load global `~/.pi/hooks.json` first
- then load ancestor project `.pi/hooks.json` files from root → leaf
- append all discovered handlers in that order
- no by-key merge, override, or dedup beyond not loading the exact same file twice

Also: Pi does **not** natively have a trust model, so trust should not be part of this ticket’s answer. Ticket #2 is only about discovery + merge order.

The conclusion is:

- Pi should copy Codex’s **append-by-layer** merge model
- but use `hooks.json` as the sole Pi Hooks config source
- the implementation should stay focused on deterministic discovery order

## #3: How should Pi load hooks after they are discovered?

Blocked by: #1, #2
Type: Research

### Question

Once `hooks.json` files are discovered, how should Pi load them into an executable in-memory form, following Codex CLI’s loading approach but adapted to Pi?

### Answer

Resolved. See:
- `docs/research/codex-hooks-findings.md`
- `docs/research/codex-hooks-merge.showboat.md`

Settled policy:
- discovery implies enabled; there is no separate enable/disable layer for now
- `hooks.json` is the only config format
- loading should follow Codex’s post-discovery shape: parse each discovered file, normalize handlers into runtime entries once, and build one in-memory registry in discovery order

Codex taught three distinct loading stages that Pi should mirror:

1. **Parse file**
   - read `hooks.json`
   - validate/parse it with `pi-hooks.schema.json`
   - ignore empty hook files

2. **Normalize handlers**
   - iterate event buckets in schema-defined order
   - iterate matcher groups in file order
   - iterate handlers in group order
   - normalize each handler into an internal runtime record containing at least:
     - source file path
     - event name
     - handler type (`command`)
     - command string
     - normalized timeout
     - matcher metadata
     - stable display order
   - apply loader-time checks here, not during dispatch:
     - reject malformed file data via schema
     - reject invalid regex matchers cleanly
     - normalize/default timeout
     - preserve exact configured order

3. **Build registry**
   - append normalized handlers from each discovered file into one registry in discovery order
   - deduplicate only at the exact file-path level, not by event or command content
   - keep this registry separate from later runtime dispatch

Important Codex lesson: loading and execution are separate concerns. Codex first builds a normalized `ConfiguredHandler` list, then later filters it by event name + matcher at runtime. Pi should do the same in TypeScript: one loader pass, one registry, then runtime selection/execution against that registry.

So for Pi, “load hooks after discovery” means:
- parse `hooks.json`
- normalize every handler once
- store them in one ordered in-memory registry
- let the runtime consume that registry later

With those decisions made, the path to implementation is now clear enough that no further decision-map tickets are required.
