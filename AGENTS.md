# AGENTS

Repository-specific routing for coding agents. Keep durable guidance here; use executable config
and linked documents for details that change with the codebase.

## Sources of truth

- Use the affected package's `package.json`, root scripts, and tool config for current commands and
  settings. If prose disagrees with executable config, follow the config and flag or fix the prose.
- Use `CONTRIBUTING.md` for setup, development workflow, testing, pull requests, changesets, and
  release expectations.
- Follow nearby source and tests for package-local conventions; avoid creating a second convention
  when an established pattern exists.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `cashubtc/coco`. External pull requests are not a triage
request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default mattpocock/skills triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a multi-context repository. Route domain work through the context map and read every
relevant glossary and ADR. See `docs/agents/domain.md`.

### Transaction design

Before changing or reviewing Wallet persistence, operation coordination, or storage adapters, read
[TRANSACTION_DESIGN.md](TRANSACTION_DESIGN.md) and
[ADR-0011](packages/core/docs/adr/0011-use-domain-transaction-gateways.md).
Keep the design as the maintained transaction contract. When changing that contract, update the
design and ADR in the same PR.

## File router

- Wallet behavior and public APIs: `packages/core`. Start in `api/` for public wrappers,
  `services/` for orchestration, `operations/` for flow state, `infra/` for transports and protocol
  handlers, `repositories/` for persistence contracts and memory implementations, and `models/`
  for domain types and errors.
- React hooks and providers: `packages/react`.
- Persistence: put repository interfaces in `packages/core`, reusable SQL repositories and schema
  logic in `packages/sql-storage`, and runtime bindings in the matching adapter:
  `packages/indexeddb`, `packages/sqlite3`, `packages/sqlite-bun`, or `packages/expo-sqlite`.
- Storage conformance helpers shared by adapters: `packages/adapter-tests`.
- CLI, daemon, and host lifecycle: `packages/cocod`; domain changes here read both the Cocod Host
  and Coco Cashu contexts through `docs/agents/domain.md`.
- Public documentation and examples: `packages/docs`.

## Workflow

1. Identify the affected packages and inspect their `package.json`, README, and relevant tests.
2. Check the working tree and preserve changes outside the requested scope.
3. Before implementation, load every document required by the applicable `Agent skills` pointer.
4. Keep changes focused. Update public exports, documentation, and tests when the changed behavior
   requires them. Edit source files rather than generated `dist/` output.
5. Run the smallest relevant verification from the affected package scripts. For shared or
   cross-package changes, also run the root build and typecheck when practical.
6. Before handoff, assess whether the change needs a changeset under `CONTRIBUTING.md`, and report
   the verification run or any unresolved failure.

## Repository-specific constraints

- Use Bun for workspace installation and scripts.
- New workspace packages with build-time dependencies on internal `@cashu/coco-*` packages must
  declare those dependencies as `peerDependencies`; the root build derives package order from that
  graph.
- For `packages/cocod`, build the workspace before commands that resolve workspace packages through
  their `dist/` exports; consult its README for the current command sequence.

Work is complete when the requested outcome is implemented, relevant verification passes (or its
failure is clearly reported), and exports, tests, documentation, and changesets have each been
considered.
