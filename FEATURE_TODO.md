# Issue #387 — Centralize Mint Quote Claimability

- [x] Fetch #387, parent #294, blockers, domain glossary, and relevant ADRs.
- [x] Confirm #300 and #390 are closed and move `ready-for-agent` to #387.
- [x] Create a fresh worktree from `origin/master` at `1601cf7`.
- [x] Inventory all Mint Quote Claimability callers and existing tests.
- [x] Test-drive one pure Claimability interface for atomic and balance policies.
- [x] Migrate model helpers, operation orchestration, watchers, handlers, lifecycle, and manager.
- [x] Rewrite superseded tests around the common assessment and preserve method-specific coverage.
- [x] Rewrite only the `Mint Quote Claimability` glossary entry in `CONTEXT.md`.
- [x] Run core unit tests, typecheck, build, formatting, and affected adapter suites.
- [x] Review against repository standards and issue #387.

## Scope boundaries

- Do not introduce Mint Issuance Attempts, Mint Batches, or the Mint Issuance Engine.
- Do not redesign the full `MintMethodHandler` interface.
- Do not change Melt Quote semantics.
- Keep BOLT11 `state` only for compatibility projection and import behavior.
- Keep Mint Quote expiry out of Claimability and caller decisions.
- Preserve Quote Observation persistence before Quote-backed Operation advancement.
