# AGENTS

## Sources of truth

- Use the affected package's `package.json`, root scripts, and tool config for current commands and
  settings. If prose disagrees with executable config, follow the config and flag or fix the prose.
- Use `CONTRIBUTING.md` for setup, development workflow, security fixes, testing, pull requests,
  changesets, and release expectations.
- When reviewing changes, including before handoff, read [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Agent skills

### Issue tracker

For issue, PRD, triage, and wayfinding work, read
[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Before applying triage labels, read [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Before domain work, read [docs/agents/domain.md](docs/agents/domain.md) and every glossary and ADR
it routes for the affected area.

### Transaction design

Before changing or reviewing Wallet persistence, operation coordination, or storage adapters, read
[TRANSACTION_DESIGN.md](TRANSACTION_DESIGN.md) and
[ADR-0011](packages/core/docs/adr/0011-use-domain-transaction-gateways.md).
Apply the design's naming, dependency, and transaction ownership rules to every affected module,
including helpers and composition-root wiring. Before handoff, complete the design's
[agent review steps](TRANSACTION_DESIGN.md#agent-review) and report the transaction boundaries
checked, relevant verification, and any remaining deviations. Passing typecheck alone does not
establish adherence. When changing the contract, update the design and ADR in the same PR.

## Package boundaries

- Persistence: put repository interfaces in `packages/core`, reusable SQL repositories and schema
  logic in `packages/sql-storage`, and runtime bindings in the matching adapter:
  `packages/indexeddb`, `packages/sqlite3`, `packages/sqlite-bun`, or `packages/expo-sqlite`.
- Storage conformance helpers shared by adapters: `packages/adapter-tests`.

## Repository-specific constraints

- Use Bun for workspace installation and scripts.
- New workspace packages with build-time dependencies on internal `@cashu/coco-*` packages must
  declare those dependencies as `peerDependencies`; the root build derives package order from that
  graph.
- For `packages/cocod`, build the workspace before commands that resolve workspace packages through
  their `dist/` exports; consult its README for the current command sequence.
