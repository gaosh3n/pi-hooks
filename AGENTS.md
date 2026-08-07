# AGENTS.md

## Agent skills

### Issue tracker

GitHub Issues are the tracker for this repo; `/triage` does not pull external PRs. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: read `CONTEXT.md` at the repo root and `docs/adr/` for architectural decisions. See `docs/agents/domain.md`.

## Research docs

### Keeping research docs legit

Research docs in `docs/research/` are for **neutral findings**, not repo policy.

When creating or revising a research doc:

- keep it limited to **facts/claims grounded in inspected sources** such as official docs, upstream repos, installed package source, specs, or direct reproducible observations
- make the doc answer: **what did we inspect, and what did we find?**
- include a **Sources inspected** section whenever practical
- keep wording neutral: describe what a source says/supports/does not clearly show
- do **not** include what this project already does, what this project should do, implementation advice, migration plans, or design recommendations
- do **not** turn research docs into issue analysis, issue bookkeeping, or project decision records

## Decision maps

1. `docs/decision-maps/pi-hooks-hooks-json.md` — config shape, validation, and discovery
2. `docs/decision-maps/pi-hooks-runtime.md` — runtime seams, matcher semantics, and stdout contract
3. `docs/decision-maps/pi-hooks-operational-loop.md` — hook-run observability, status, and TUI/operator flow
