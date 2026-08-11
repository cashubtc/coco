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

## PR #400 stack reconciliation

- [x] Refresh and pin PR #400 at `7bacc48df5e9012b3fcc1e43a05648eaa264f1b3`.
- [x] Rebase the PR #398 delta onto the pinned PR #400 head.
- [x] Transplant only the claimability delta onto `master` after PR #400 merged.
- [x] Remove competing BOLT11-specific runtime claimability predicates.
- [x] Preserve locked BOLT11 creation, signing, and exact-output recovery through the common seam.
- [x] Keep ownership contradictions ambiguity-preserving for future `needs_attention` recovery.
- [x] Restore transactional, monotonic repository observation and compatibility-state updates.
- [x] Fix explicit execution versus Background Watcher/processor coordination.
- [x] Run focused, adapter contract, build, typecheck, and formatting verification.
- [ ] Run Docker-backed live-mint integration tests (Docker is unavailable in this environment).
- [x] Review the combined stack against issues #387 and #365.

## PR #403 execution-race follow-up

- [x] Remove the stale pending-only precondition from the public Mint Ops interface.
- [x] Join active local execution and recover orphaned executing operations in the service.
- [x] Cover the public race and the authoritative execution state table.
- [x] Run focused and full core unit tests, typecheck, and build for the follow-up.
- [x] Re-run Docker-backed core integration tests with the required mint and auth environment.

## PR #403 review fixes

- [x] Treat a remote BOLT11 `20007` rejection as terminal during execution recovery.
- [x] Verify terminal recovery emits failure without re-emitting pending work.
- [x] Run focused core tests, typecheck, build, and formatting checks.
- [x] Treat remote BOLT12 and on-chain `20007` rejections as terminal during recovery.
- [x] Preserve retryability for non-protocol errors whose messages contain `expired`.
- [x] Run focused core tests, typecheck, build, and formatting checks for reusable methods.
