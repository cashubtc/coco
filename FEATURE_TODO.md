# Quote Feature Merge Readiness

Current status: **ready for merge review after local verification**.

This document is the handoff for the `feat/decoupled-quotes` cleanup pass.

Completion boundary for this pass:

- Merge-readiness was checked against the current branch and `origin/master`.
- Accepted findings were fixed at the quote-operation boundary.
- Regression coverage was added for both URL-normalization cases.
- The sqlite-bun CI integration failure was fixed at the pending quote observation
  boundary.
- Local review reports no accepted/actionable findings.

## Scope Reviewed

- Base: `origin/master` at `c321b3047f49fb43a46f5b6a2e1a530b749b4eee`
- Branch: `feat/decoupled-quotes`
- Diff size: 88 files, including core quote lifecycle, mint/melt operation APIs,
  adapter repositories/schema migrations, React hook event updates, docs, and
  changesets.
- Remote refs were refreshed before review.

## Findings Fixed

### P2: Bind melt operations to the canonical quote mint URL

- File: `packages/core/operations/melt/MeltOperationService.ts:168`
- Problem: the quote repository normalizes and returns `quote.mintUrl`, but the
  operation is created with the caller-supplied `mintUrl`. If the caller passes a
  variant such as a trailing slash or different host casing, the operation can be
  stored under a different mint URL than the canonical quote. Later quote-based
  lookups using the canonical quote identity can miss the prepared operation.
- Fix: `prepareExistingQuote()` initializes the operation with `quote.mintUrl`.
- Regression: `MeltOperationService.test.ts` prepares with a variant URL and
  asserts canonical quote lookup resolves the prepared operation.

### P2: Look up imported mint quotes by canonical identity

- File: `packages/core/operations/mint/MintOperationService.ts:234`
- Problem: the imported quote may have been persisted under normalized
  `imported.mintUrl` and `imported.quoteId`, while the duplicate-operation check
  still uses the raw caller input. Re-importing the same quote with a non-canonical
  mint URL can miss the existing operation and create a duplicate operation for
  the same canonical quote.
- Fix: `importQuote()` checks for existing operations with `imported.mintUrl` and
  `imported.quoteId`.
- Regression: `MintOperationService.test.ts` imports the same quote twice with a
  variant URL and asserts the second import reuses the first operation.

### P2: Serialize pending mint quote observations with execution

- File: `packages/core/operations/mint/MintOperationService.ts:945`
- Problem: `./scripts/test-integration.sh sqlite-bun` failed when a NUT-17
  mint quote notification raced with manual `ops.mint.execute()`. The watcher
  could start a pending observation update, `execute()` could move the same
  operation to `executing`, and the stale observation write could then restore
  the row to `pending`. Finalization then failed with
  `Cannot finalize operation ... in state pending`.
- Fix: pending observation writes now use the same per-operation lock, and
  `execute()` waits for an in-flight observation lock before reloading the
  operation.
- Regression: `MintOperationService.test.ts` stalls a pending observation write
  and asserts execution cannot start until the observation releases the lock.

## Verification Run

Post-fix verification passed:

- `git diff --check`
- `bun prettier packages/core/operations/mint/MintOperationService.ts packages/core/operations/melt/MeltOperationService.ts packages/core/test/unit/MintOperationService.test.ts packages/core/test/unit/MeltOperationService.test.ts FEATURE_TODO.md --check`
- `bun run --filter='@cashu/coco-core' test -- test/unit/MintOperationService.test.ts`
  (`32 pass`)
- `bun run --filter='@cashu/coco-core' test -- test/unit/MeltOperationService.test.ts`
  (`37 pass`)
- `bun run --filter='@cashu/coco-core' typecheck`
- `./scripts/test-integration.sh sqlite-bun` (`76 pass`)
- `./scripts/test-integration.sh sqlite-bun --custom-unit usd` (`80 pass`)
- `bun run --filter='@cashu/coco-core' test:unit` (`772 pass`)
- `~/.codex/skills/codex-review/scripts/codex-review --mode local --full-access`
  reported no accepted/actionable findings.

Earlier broad baseline passed before fixing the accepted findings:

- `git fetch origin`
- `git diff --check origin/master...HEAD`
- `bun run typecheck`
- `bun run build`
- `bun run --filter='@cashu/coco-core' test:unit` (`770 pass`)
- `bun run --filter='@cashu/coco-react' typecheck`
- `bun run --filter='@cashu/coco-react' lint`
- `bun run docs:build`
- `bun --cwd packages/sqlite3 vitest run src/test/contract.test.ts src/test/schema.test.ts src/test/SendOperationRepository.test.ts src/test/MintOperationRepository.test.ts src/test/MeltOperationRepository.test.ts` (`49 pass`)
- `bun --cwd packages/sqlite-bun test src/test/contract.test.ts src/test/schema.test.ts src/test/SendOperationRepository.test.ts src/test/MintOperationRepository.test.ts src/test/MeltOperationRepository.test.ts` (`49 pass`)
- `bun --cwd packages/expo-sqlite test src/test/contract.test.ts src/test/schema.test.ts src/test/SendOperationRepository.test.ts src/test/MintOperationRepository.test.ts src/test/MeltOperationRepository.test.ts` (`49 pass`)
- `bun vitest run src/test/contract.test.ts` from `packages/indexeddb` with
  local server permissions (`31 pass`, Chromium)

Expected local-environment failures observed:

- `bun run --filter='@cashu/coco-indexeddb' test` fails under plain Node/Bun
  because Dexie has no IndexedDB API outside the browser test runner.
- Full sqlite-bun and expo-sqlite package test commands include
  `src/test/integration.test.ts`, which throws when `MINT_URL` is not set.

Review:

- `~/.codex/skills/codex-review/scripts/codex-review --mode branch --base origin/master --full-access`
  reported the two accepted P2 findings listed above.

## Merge Checklist

- [x] Fix canonical mint URL binding in `MeltOperationService.prepareExistingQuote()`.
- [x] Fix canonical identity lookup in `MintOperationService.importQuote()`.
- [x] Fix sqlite-bun CI race between pending quote observations and mint execution.
- [x] Add focused regression coverage for both URL-normalization cases.
- [x] Add focused regression coverage for pending observation execution locking.
- [x] Rerun focused verification.
- [x] Rerun Codex review and require no accepted/actionable findings.
