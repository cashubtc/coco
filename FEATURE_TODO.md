# PR 182 Rebase Plan

## Goal

Adapt PR 182 (`feat/bolt12-payments`) so it rebases cleanly on top of
`feat/onchain` and implements BOLT12 through the generic quote-first primitives
introduced there.

The desired end state is not a mechanical conflict resolution. Keep the BOLT12
melt implementation from PR 182, but reshape BOLT12 mint so it uses the same
canonical reusable quote model as onchain minting:

```text
canonical quote -> method quoteData -> reusable quote watcher -> reusable claim path
```

## Current Baseline

- PR branch head: `3028655 chore: account for quotelifeCycle operation  in bolt12 methods`
- Target branch head to use for implementation: `feat/onchain` at `e921f88`
  (`format`). Earlier inspection used `2546058`; the later delta is expected to
  be database-adapter focused.
- Both branches originally fork from `master` at `0322917`
- A no-commit trial merge onto `feat/onchain` conflicts in core API, quote lifecycle,
  mint operation service, watchers/processors, schema migrations, docs, hooks, and tests.

## Implementation Status

- Rebased the PR 182 stack onto `feat/onchain` head `e921f88` on the new source branch
  `feat/bolt12-payments-on-onchain`.
- Preserved the original PR 182 contributor author on the replayed commits.
- Committed follow-up adaptation work as
  `e5159d4 fix(core): align bolt12 mint with reusable quotes`.
- Ported BOLT12 melt support and reshaped BOLT12 mint around reusable canonical quotes.
- Removed the old BOLT12 per-operation paid allocation path in favor of generic reusable quote
  claiming.
- Added the follow-up extraction note at `issues/reusable-mint-claim-service.md`.
- Generalized watcher/processors/service behavior so reusable auto-claiming follows
  `quote.reusable === true` instead of checking a specific method.
- Fixed amountless BOLT12 quote creation so API callers omit `amount` rather than passing
  `amount: undefined`.
- Corrected fixed-amount BOLT12 mint semantics: the quote amount is offer/payment metadata, while
  each mint operation must provide the amount to mint from the reusable quote balance.
- Verification is current as of 2026-05-29. The full SQLite package `test` script still needs a
  live `MINT_URL`; the non-network repository and schema coverage passes.

## High-Level Strategy

1. Port the melt side mostly as-is.
2. Rework the mint side around `feat/onchain`'s generic reusable primitives.
3. Keep duplicate quote-id-safe persistence, but align migrations with the newer schema state.
4. Update docs/tests after behavior is settled, not before.
5. Preserve the contributor's PR 182 commits by rebasing/cherry-picking with
   original authorship intact; do not squash into a single port commit.
6. Publish the adapted result on a new branch/PR for iteration, not by
   force-pushing the original PR branch.

## Phase 1: Preserve BOLT12 Melt Support

- [ ] Keep `packages/core/infra/handlers/melt/BaseBoltMeltHandler.ts`.
- [ ] Keep `packages/core/infra/handlers/melt/MeltBolt12Handler.ts`.
- [ ] Keep the shared utility rename:
      `MeltBolt11Handler.utils.ts` -> `BoltMeltHandler.utils.ts`.
- [ ] Keep `MeltBolt11Handler` as a small subclass of `BaseBoltMeltHandler`.
- [ ] Register `bolt12` in `MeltHandlerProvider` and `Manager`.
- [ ] Keep `MeltOperation` / `MeltOperationService` changes needed for BOLT12 quote data.
- [ ] Keep `MeltOpsApi` support for `bolt12`.
- [ ] Keep `bolt12_melt_quote` in subscription types and polling transport.
- [ ] Keep melt docs and tests, adjusting only for target branch API drift.

Expected conflict level: moderate. This side does not deeply overlap with
onchain reusable minting.

## Phase 2: Redefine BOLT12 Mint Method Shape

- [ ] Add `bolt12` to `MintMethodDefinitions` in
      `packages/core/operations/mint/MintMethodHandler.ts`.
- [ ] Do not copy PR 182's old stateful BOLT12 definition directly.
- [ ] Define BOLT12 mint as reusable quote data, similar to `onchain`:
  - `methodData`: `Record<string, never>`; BOLT12 mint operation-level method
    data should be empty.
  - `createQuoteData`: quote creation payload: `unit`, optional `amount`,
    optional `description`.
  - `quoteData`: `pubkey`, optional fixed `amount`, `amountPaid`, `amountIssued`.
  - `remoteState`: `never`; reusable BOLT12 mint lifecycle is driven by
    canonical quote counters, not per-operation remote states.
  - `quote`: `MintQuoteBolt12Response`.
- [ ] Ensure handler context uses `createQuoteData`, not PR 182's older `intent`
      plus `methodData` quote-creation shape.
- [ ] Keep `validateQuoteForPrepare?` support from `feat/onchain`.

## Phase 3: Extend Canonical Mint Quotes

- [ ] Add a `Bolt12MintQuote` variant in `packages/core/models/MintQuote.ts`.
- [ ] Add `mintQuoteFromBolt12Response()`.
- [ ] Update `MintQuote` union to include `bolt12`.
- [ ] Update `mintQuoteToMethodSnapshot()` for BOLT12.
- [ ] Update `getMintQuoteAvailableAmount()` so BOLT12 computes:

  ```text
  available = amountPaid - amountIssued
  ```

- [ ] Keep BOLT12 quote `amount` as fixed-offer payment metadata only; BOLT12
      mint operations should choose an explicit amount from the reusable quote
      balance.
- [ ] Update `isMintQuotePending()` so reusable BOLT12 quotes remain pending while
      watchable, like onchain.
- [ ] Keep BOLT11 state downgrade protection unchanged.
- [ ] Generalize helper names where useful:
  - `MintQuoteOnchainResponse` may become a reusable quote response alias only if
    that improves clarity.
  - Avoid leaking BOLT12-specific accounting into generic callers.
- [ ] Generalize reusable quote counter merging so BOLT12 and onchain both keep
      `amountPaid` and `amountIssued` monotonic across stale polling/watcher
      payloads.

## Phase 4: Rework `MintBolt12Handler`

- [ ] Keep the BOLT12 protocol calls from PR 182:
  - `wallet.createMintQuoteBolt12(...)`
  - `wallet.mintProofsBolt12(...)`
- [ ] Replace PR 182's generic keyring usage with the target branch's mint quote
      key APIs:
  - `generateMintQuoteKeyPair()`
  - `getMintQuoteKeyPair(pubkey)`
- [ ] Use compressed NUT-20-style quote public keys as onchain does.
- [ ] Make `createQuote()` consume method-specific `createQuoteData`.
- [ ] Make `fetchRemoteQuote()` call the generic adapter API:

  ```ts
  mintAdapter.checkMintQuote(mintUrl, 'bolt12', quoteId);
  ```

- [ ] Make `prepare()` mirror `MintOnchainHandler.prepare()`:
  - require the imported canonical quote snapshot;
  - verify quote id, unit, pubkey, and key availability;
  - create deterministic keep outputs for the operation amount;
  - persist `request`, `expiry`, `pubkey`, and serialized output data.
- [ ] Make `execute()` mirror onchain reusable mint execution, using
      `mintProofsBolt12()` and the quote private key.
- [ ] Make `recoverExecuting()` mirror onchain recovery semantics:
  - recover signed outputs first;
  - validate quote pubkey/unit;
  - return `PENDING` when available paid balance is insufficient;
  - return `TERMINAL` for expiry or unrecoverable key mismatch;
  - save recovered proofs before finalization.
- [ ] Make `checkPending()` return a `quoteSnapshot` when useful and avoid
      per-operation fake remote states for reusable quotes.
- [ ] Remove or replace `Bolt12MintQuoteAccounting.ts`; its per-operation paid
      allocation should be handled by generic reusable quote claiming instead.
- [ ] Remove PR 182's `observeReusableBolt12PendingOperation()` and
      `recordReusableBolt12Observations()` paths; reusable pending checks should
      record canonical quote snapshots and let reusable claiming decide execution.

## Phase 5: Generalize Reusable Mint Claiming

- [ ] In `MintOperationService`, replace method-specific checks like
      `method === 'onchain'` with quote capability checks where possible:
  - load the canonical quote;
  - branch on `quote.reusable`;
  - keep BOLT11 on the ordinary ready/finalize queue.
- [ ] Generalize `claimMintQuote()` so it accepts reusable methods, not just
      `'onchain'`.
- [ ] Generalize `claimPendingMintQuotes()` so it sweeps all pending reusable
      quotes, or accepts a reusable method filter.
- [ ] Generalize `hasLocallyClaimableMintQuoteBalance()` beyond onchain.
- [ ] Generalize `createAutoClaimOperation()` so it can prepare BOLT12 reusable
      quote operations with the correct method data.
- [ ] Trigger auto-claim for any refreshed or watched quote where
      `quote.reusable === true`; do not branch on method.
- [ ] Keep reusable claim orchestration inside `MintOperationService` for this
      PR, and track a follow-up extraction in
      `issues/reusable-mint-claim-service.md`.
- [ ] Keep the core invariant from `feat/onchain`:

  ```text
  claimable = remote paid - effective issued - locally executing reservations
  ```

- [ ] Do not keep PR 182's BOLT12-specific pending operation allocation as the
      source of truth.

## Phase 6: Quote Lifecycle Integration

- [ ] Extend `QuoteLifecycle.createMintQuote()` overloads/API to support BOLT12
      create quote data.
- [ ] Extend `resolveAndPersistMintQuoteSnapshot()` for `bolt12`.
- [ ] Merge reusable BOLT12 `amountPaid` and `amountIssued` monotonically, as
      onchain does.
- [ ] Ensure incomplete reusable snapshots are handled defensively.
- [ ] Constrain public mint operation quote import so BOLT12 does not type-check;
      BOLT12 quotes require locally generated mint quote key material and should be
      created through `quotes.mint.create()`.
- [ ] Constrain public BOLT12 mint quote import anywhere it would persist a
      quote without local mint quote key material. Internal watcher/refresh
      observation can still record BOLT12 quote snapshots.
- [ ] Update `methodDataFromMeltQuote()` for BOLT12 melt quote preparation.
- [ ] Preserve `mint-quote:updated` event emission only when relevant remote
      state/amount data changes.

## Phase 7: Watchers and Processors

- [ ] Add `bolt12_mint_quote` to `SubscriptionKind`.
- [ ] Add a BOLT12 mint watch policy in
      `MintOperationWatcherService` that mirrors reusable onchain behavior:
  - subscription kind: `bolt12_mint_quote`;
  - payload quote id from `payload.quote`;
  - record only complete reusable settlement payloads;
  - do not unsubscribe merely because one operation finalized.
- [ ] Keep one subscription per canonical quote interest, not one subscription per
      local operation.
- [ ] Update `MintOperationProcessor` so quote updates for any reusable mint quote
      schedule reusable quote claiming.
- [ ] Keep BOLT11 queue/finalize behavior unchanged.
- [ ] Remove BOLT12-specific processor allocation logic from PR 182.
- [ ] Update polling transport to use generic BOLT12 quote checks consistently.

## Phase 8: Adapter and Subscriptions

- [ ] Prefer target branch generic mint adapter methods:
  - keep `checkMintQuote(mintUrl, method, quoteId)`;
  - do not add or keep one-off `checkMintQuoteBolt12()` for mint quote checks.
- [ ] Add or keep BOLT12 melt adapter helpers where generic melt support does not
      exist yet:
  - `checkMeltQuoteBolt12()`
  - `checkMeltQuoteBolt12State()`
  - `customMeltBolt12()`
- [ ] Update `PollingTransport` for:
  - `bolt12_mint_quote`;
  - `bolt12_melt_quote`.
- [ ] Update `SubscriptionApi` helpers to accept BOLT12 where exposed.

## Phase 9: Public APIs and React Hooks

- [ ] Extend default supported mint methods:
  - `MintOpsApi`: `bolt11 | onchain | bolt12`.
  - `QuoteApi`: `bolt11 | onchain | bolt12`.
- [ ] Preserve quote-first mint preparation:
  - callers create a BOLT12 quote through `coco.quotes.mint.create()`;
  - callers prepare with `quoteId`;
  - fixed-amount BOLT12 can omit amount during prepare and use the quote amount;
  - amountless BOLT12 requires explicit operation amount during prepare.
- [ ] Do not reintroduce the old prepare-without-quote flow from PR 182 docs/tests.
- [ ] Keep `listByQuote()` additions if target branch does not already expose
      them everywhere needed.
- [ ] Ensure `importQuote()` remains limited to methods that actually work.
- [ ] Extend default supported melt methods:
  - `MeltOpsApi`: `bolt11 | bolt12`.
- [ ] Update React hooks for BOLT12 mint/melt type passthrough and quote lookup
      helpers, matching the target branch's current hook surface.

## Phase 10: Persistence and Migrations

- [ ] Reconcile PR 182 schema migrations with `feat/onchain` migrations.
- [ ] Keep duplicate quote-id-safe behavior for reusable quote methods.
- [ ] Ensure mint operation repositories can persist BOLT12 method data, pubkey,
      and duplicate quote IDs.
- [ ] Ensure mint quote repositories can persist BOLT12 quote data:
  - optional fixed amount;
  - `amountPaid`;
  - `amountIssued`;
  - `pubkey`.
- [ ] Apply changes consistently across:
  - `packages/sqlite3/src/schema.ts`
  - `packages/sqlite-bun/src/schema.ts`
  - `packages/expo-sqlite/src/schema.ts`
  - `packages/indexeddb/src/lib/schema.ts`
- [ ] Update repository tests for duplicate quote IDs and BOLT12 quote data.

## Phase 11: Docs

- [ ] Fix BOLT12 mint docs to show quote-first flow:

  ```ts
  const quote = await coco.quotes.mint.create({
    mintUrl,
    method: 'bolt12',
    unit: 'sat',
    // optional amount/description depending on final API
  });

  const operation = await coco.ops.mint.prepare({
    mintUrl,
    method: 'bolt12',
    quoteId: quote.quoteId,
    amount: 100,
  });
  ```

- [ ] Fix BOLT12 melt docs to show quote-first flow:

  ```ts
  const quote = await coco.quotes.melt.create({
    mintUrl,
    method: 'bolt12',
    methodData: { offer, amountSats },
  });

  const operation = await coco.ops.melt.prepare({
    mintUrl,
    method: 'bolt12',
    quoteId: quote.quoteId,
  });
  ```

- [ ] Update migration docs to explain BOLT12 alongside onchain reusable quotes.
- [ ] Keep examples aligned with TypeScript types.

## Settled Decisions

- BOLT12 mint uses reusable canonical quote semantics, not PR 182's older
  per-operation paid allocation.
- Fixed-amount BOLT12 reusable quotes may be prepared without an explicit
  operation amount; amountless BOLT12 quotes require one.
- Public mint operation quote import remains limited to methods with usable local
  key material, currently BOLT11. BOLT12 quotes are created through
  `quotes.mint.create()`.
- Reusable quote auto-claiming is capability-driven: any quote with
  `reusable === true` is eligible when the runtime learns of a new deposit via
  manual refresh or watcher updates.
- Reusable claim extraction is deferred; see
  `issues/reusable-mint-claim-service.md`.
- BOLT12 mint quote creation uses `createQuoteData` with optional `amount`;
  there is no `amountless` boolean.
- BOLT12 mint operation `methodData` is empty; quote creation metadata belongs
  in `createQuoteData`, and reusable settlement metadata belongs in `quoteData`.
- Mint quote refresh/checks use the generic mint adapter
  `checkMintQuote(mintUrl, method, quoteId)`, including BOLT12.
- BOLT12 mint watcher payloads update canonical quote snapshots only; they do
  not allocate paid state to individual operations.
- Reusable quote counter merging is monotonic for all reusable methods.
- BOLT12 mint uses the dedicated NUT-20 mint quote key APIs:
  `generateMintQuoteKeyPair()` and `getMintQuoteKeyPair(pubkey)`.
- BOLT12 melt remains quote-first but separate from reusable mint claiming,
  using the shared bolt melt handler and method-specific BOLT12 melt adapter
  calls.
- Default public APIs include every method wired by `Manager`, while unsupported
  import paths are excluded at the type level.
- Docs should describe reusable quote behavior once for onchain and BOLT12:
  refresh/watcher updates persist settlement counters and auto-claim locally
  claimable balances.
- Verification should start with focused core tests and core typecheck, then
  expand to touched adapter schema tests, React checks, and docs build only as
  those surfaces change.
- Implement against the current `feat/onchain` head, not the older inspected
  `2546058` commit.
- Preserve PR 182 contributor authorship. Rebase the PR 182 stack onto current
  `feat/onchain`, keep original authors on rewritten commits, and add follow-up
  adaptation commits only where changes do not naturally belong to an original
  commit.
- Do not force-push over the original PR branch; create a new branch and PR for
  the rebased/adapted work.
- Use a new source branch such as `feat/bolt12-payments-on-onchain`, targeting
  `feat/onchain`.

## Phase 12: Tests

- [x] Keep and adapt BOLT12 melt handler tests.
- [x] Rewrite BOLT12 mint handler tests around reusable quote data and
      mint-quote keyring APIs.
- [x] Update `MintOperationService` tests:
  - BOLT12 fixed quote preparation;
  - BOLT12 amountless quote preparation with explicit amount;
  - reusable claim selection shared with onchain;
  - auto-claim remaining balance for any reusable quote.
- [x] Update watcher tests:
  - one canonical BOLT12 quote subscription;
  - complete settlement payload persistence;
  - no unsubscribe after one reusable operation finalizes.
- [x] Update processor tests:
  - BOLT12 quote update schedules generic reusable claim;
  - BOLT11 queue remains unchanged.
- [x] Update API tests:
  - BOLT12 mint quote create;
  - BOLT12 mint prepare requires `quoteId`;
  - amountless prepare requires explicit amount;
  - BOLT12 mint operation quote import is excluded from public types.
- [x] Update React hook checks for typed BOLT12 passthrough.
- [ ] Update live integration tests only after a local mint is available.

## Known Conflict Clusters

The trial merge against `feat/onchain` conflicts in these areas:

- `packages/core/Manager.ts`
- `packages/core/api/MintOpsApi.ts`
- `packages/core/api/QuoteApi.ts`
- `packages/core/infra/MintAdapter.ts`
- `packages/core/infra/SubscriptionProtocol.ts`
- `packages/core/infra/handlers/mint/index.ts`
- `packages/core/operations/mint/MintMethodHandler.ts`
- `packages/core/operations/mint/MintOperationService.ts`
- `packages/core/quotes/QuoteLifecycle.ts`
- `packages/core/services/watchers/MintOperationProcessor.ts`
- `packages/core/services/watchers/MintOperationWatcherService.ts`
- schema files for sqlite3, sqlite-bun, expo-sqlite, and indexeddb
- mint API/hook/docs/tests

## Suggested Commit Order

1. Port BOLT12 melt handler/provider/adapter/subscription support.
2. Add BOLT12 mint method and canonical quote model.
3. Rework `MintBolt12Handler` onto reusable quote primitives.
4. Generalize reusable mint claim service paths beyond onchain.
5. Update watcher/processor integration for reusable BOLT12 quotes.
6. Reconcile persistence migrations and repositories.
7. Update public APIs and React hooks.
8. Update docs.
9. Update and run focused tests.

## Verification Checklist

- [x] `bun run --filter='@cashu/coco-core' test -- test/unit/MeltBolt12Handler.test.ts`
- [x] `bun run --filter='@cashu/coco-core' test -- test/unit/MintBolt12Handler.test.ts`
- [x] `bun run --filter='@cashu/coco-core' test -- test/unit/MintOperationService.test.ts`
- [x] `bun run --filter='@cashu/coco-core' test -- test/unit/MintOperationWatcherService.test.ts`
- [x] `bun run --filter='@cashu/coco-core' test -- test/unit/MintQuoteProcessor.test.ts`
- [x] `bun run --filter='@cashu/coco-core' test -- test/unit/QuoteApi.test.ts`
- [x] `bun run --filter='@cashu/coco-core' typecheck`
- [x] `bun run --filter='@cashu/coco-core' build`
- [x] `bun run --filter='@cashu/coco-react' lint`
- [x] `bun run --filter='@cashu/coco-react' typecheck`
- [x] `bun run docs:build`
- [x] SQLite non-network repository/schema tests:
      `bun run test -- src/test/schema.test.ts src/test/contract.test.ts src/test/MintOperationRepository.test.ts src/test/MeltOperationRepository.test.ts src/test/SendOperationRepository.test.ts --reporter verbose`
- [ ] Full SQLite integration suite: `bun run --filter='@cashu/coco-sqlite' test` needs
      `MINT_URL`.
