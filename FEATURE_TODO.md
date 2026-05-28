# Mint Quote Import and Operation Boundary Refactor

## Goal

Move mint quote import and mutable quote state ownership out of
`MintOperationService` and into `QuoteLifecycle` / `manager.quotes.mint`, while
keeping mint operations focused on operation lifecycle state.

This is a hard API break. Document it in
`packages/docs/starting/migrating-from-v1.md`.

## Agreed API Shape

- Remove `manager.ops.mint.importQuote(...)`.
- Add `manager.quotes.mint.import(...)`.
- `quotes.mint.import(...)` requires an explicit `method` for now.
- `quotes.mint.import(...)` accepts `MintMethodQuoteSnapshot<M>`.
- `quotes.mint.import(...)` returns only `MintQuote`.
- Importing a quote does not create a mint operation or history entry.
- To redeem an imported quote, callers must import first, then prepare:

```ts
const quote = await manager.quotes.mint.import({
  mintUrl,
  method: 'bolt11',
  quote: quoteSnapshot,
});

const operation = await manager.ops.mint.prepare({
  mintUrl: quote.mintUrl,
  method: quote.method,
  quoteId: quote.quoteId,
});
```

## Quote Import Semantics

- Import belongs in `QuoteLifecycle`, not `MintOperationService`.
- Add a public lifecycle method like:

```ts
async importMintQuote(
  mintUrl: string,
  method: MintMethod,
  snapshot: MintMethodQuoteSnapshot,
): Promise<MintQuote>
```

- Keep a lower-level helper for normalization/merge if useful.
- Public import must:
  - normalize `mintUrl` before trust and capability checks
  - require trusted mints
  - canonicalize the snapshot
  - validate BOLT11 amount is present and positive
  - validate mint capabilities immediately
  - persist the canonical quote
  - emit `mint-quote:updated` only according to the event rules below
- Capability validation:
  - BOLT11: `assertMethodUnitSupported(mintUrl, 4, 'bolt11', { amount, unit })`
  - onchain: `assertMethodUnitSupported(mintUrl, 4, 'onchain', unit)`
  - validate against the canonical quote that import resolves to, not the raw input
- Support both `bolt11` and `onchain`.
- Do not validate local ownership of onchain quote pubkeys during import.
  Ownership is checked during operation prepare.
- Allow importing `ISSUED` and expired quotes.
- Do not call prepare eligibility checks from import.

## Quote Merge and Event Rules

- Preserve existing monotonic behavior:
  - BOLT11 state must not downgrade, for example `PAID` to `UNPAID`.
  - Onchain `amountPaid` / `amountIssued` merge upward by max value.
- If import receives a stale snapshot and existing canonical quote wins:
  - return the existing canonical quote
  - still run trust/capability validation against that returned quote
  - do not emit
- Public import should throw if the returned canonical quote no longer passes
  capability validation.
- Track event emission with a narrow internal flag such as `remoteStateChanged`,
  not a broad `changed` flag.
- Remote state change comparison:
  - quote identity is `mintUrl + method + quoteId`
  - for onchain snapshots, compare only `amount_paid` and `amount_issued`
  - if those fields are undefined, compare `state`
  - do not use request/address, expiry, pubkey, timestamps, or storage metadata
    to decide event emission
- Metadata changes should still be persisted and returned, but they should not
  emit by themselves. They are important but expected to be stable.
- Emit `mint-quote:updated` when:
  - a canonical quote is newly created/imported
  - remote settlement state changes by the rule above
- Do not emit when:
  - only observation timestamps change
  - only stable metadata changes
  - an incoming snapshot is stale/no-op
- Apply the same event rule to:
  - `quotes.mint.import(...)`
  - `QuoteLifecycle.recordMintQuoteSnapshot(...)`
  - `QuoteLifecycle.refreshMintQuote(...)`
  - `QuoteLifecycle.recordMintQuoteObservation(...)`
- `quotes.mint.create(...)` still emits for newly created quotes.
- New terminal or expired imports still emit because listeners decide whether to
  act on the new canonical quote.
- Document `mint-quote:updated` as quote creation/import or remote settlement
  state change, not arbitrary metadata persistence.

## Mint Operation Service Refactor

- Remove operation-service-level quote import behavior.
- Remove `MintOperationService.importQuote(...)`.
- Remove `MintOpsApi.importQuote(...)`.
- Remove `ImportMintQuoteInput` from `MintOpsApi.ts`.
- Add `ImportMintQuoteInput` to `QuoteApi.ts` next to quote APIs.
- Rename `prepareExistingQuote(...)` to service-level `prepare(...)`.
- Fold old operation-id `prepare(...)` into a private helper, for example
  `prepareInitOperation(...)`.
- Remove the `importedQuote` option from the private prepare helper.
  The helper must always load the canonical quote through `QuoteLifecycle`.
- Make `init(...)` private/internal, for example `createInitOperation(...)`,
  if no production source outside `MintOperationService` uses it.
- Tests should stop calling `service.init(...)` and old operation-id
  `service.prepare(...)` directly. Exercise behavior through quote-level
  `service.prepare(...)`.
- Keep single-use quote prepare non-idempotent:
  - if any operation already tracks a non-reusable quote, throw
  - callers that want lookup semantics use `ops.mint.getByQuote(...)`
- Preserve reusable onchain behavior:
  - repeated `prepare(...)` calls can create multiple pending operations with
    explicit amounts
- Keep operation stable metadata (`request`, `expiry`, `pubkey`) on operations
  for now.
- Remove only the CODEX comments answered by this refactor.

## Watcher and Processor Refactor

- `MintOperationWatcherService` should depend directly on
  `packages/core/quotes/QuoteLifecycle.ts` for quote concerns.
- Watcher should use `QuoteLifecycle` for:
  - listing pending canonical mint quotes on start
  - recording mint quote snapshots from subscription payloads
- Watcher should keep using `MintOperationService` only for operation concerns.
- Do not add explicit watcher orchestration to quote import.
  Public quote import persists and emits; the watcher reacts to
  `mint-quote:updated`.
- Existing watcher event path is aligned:
  - it listens for `mint-quote:updated`
  - it starts watching canonical quotes according to policy
  - it skips/stops for expired or terminal snapshots
  - it checks trust before subscribing
- `MintOperationProcessor` should also depend on `QuoteLifecycle` directly for
  canonical quote reads.
- Processor should keep using `MintOperationService` for operation actions:
  - `getOperationsForQuote(...)`
  - `claimMintQuote(...)`
  - `hasLocallyClaimableMintQuoteBalance(...)`
- Keep processor subscribed to `mint-op:pending`.
  Use it only to handle a pending operation created after its quote is already
  `PAID`; load the canonical quote and enqueue if appropriate.

## Remove Mutable Quote State From Mint Operations

- Remove `lastObservedRemoteState` and `lastObservedRemoteStateAt` from the core
  mint operation domain model.
- Keep old adapter storage columns as inert compatibility fields for now.
- Existing operation-level remote state may still be used by migrations/backfills
  into canonical quote rows, then ignored afterward.
- Repositories should phase out reading/writing operation remote state:
  - writes should store `NULL` or omit where possible
  - reads should not surface these fields on `MintOperation`
- Remove `MintOperationService` listener that copies quote remote state into
  pending operations.
- Remove `recordPendingObservation(...)`.
- `MintBolt11Handler.prepare(...)` must stop setting remote state on operations.
- `PendingMintCheckResult.observedRemoteState` stays for now. It is an immediate
  method observation, not operation state.
- `checkPayment(...)` should:
  - update canonical quote state through `QuoteLifecycle`
  - return the observation result
  - not rewrite the operation merely because quote state changed
- `mint-op:pending` event payloads should no longer include quote remote state.
- `MintQuote` itself keeps `state` and `lastObservedRemoteState` for now.

## History and Compatibility

- Continue exposing mint history `remoteState` for compatibility where practical.
- Source history `remoteState` from canonical mint quote rows, not operation rows.
- If no canonical quote row exists, omit `remoteState`.
- Do not expand repository interfaces just for history remote state.
  Adapter `HistoryRepository` implementations can join/read storage internally.
- Memory/core history projection can use quote repositories where already
  available; otherwise omit `remoteState`.

## Legacy Reconciliation

- Keep `manager.reconcileLegacyMintQuotes()` behavior: it still reconciles
  legacy single-use BOLT11 quotes into prepared operations.
- Internally switch it from `mintOperationService.importQuote(...)` to:
  - `QuoteLifecycle.importMintQuote(...)`
  - `MintOperationService.prepare(...)`
- Use the public-like quote import path with trust/capability validation.
- On validation failure, log and skip the legacy quote as today.

## React Package

- Remove `useMintOperation().importQuote(...)`.
- Remove `MintOperationImportQuoteInput`.
- Do not add a new quote hook in this refactor.
- React callers can use `useManager()` and `manager.quotes.mint.import(...)`
  until quote hooks are designed later.

## Docs

- Update `packages/docs/starting/migrating-from-v1.md`.
- Document hard API break:
  - `manager.ops.mint.importQuote(...)` removed
  - use `manager.quotes.mint.import(...)` plus `manager.ops.mint.prepare(...)`
- Explain `quotes.mint.import(...)` only updates canonical quote state.
- Explain it starts watching through `mint-quote:updated`, but does not create
  history or operations.
- Explain mint operations no longer mirror quote remote state.
  Use `mint-quote:updated` or `manager.quotes.mint.get(...)` for quote payment
  state.
- Update any README/docs references to `ops.mint.importQuote`.

## Implementation Checklist

- [x] Add quote import input and API method to `QuoteApi.ts`.
- [x] Add `QuoteLifecycle.importMintQuote(...)` with trust/capability validation.
- [x] Refactor quote import/record/refresh/observation to emit only on quote
      creation/import or remote settlement state change.
- [x] Remove `MintOperationService.importQuote(...)`.
- [x] Rename/fold `prepareExistingQuote(...)` into `prepare(...)`.
- [x] Make init operation creation private/internal.
- [x] Remove service-level quote passthroughs no longer needed by watcher.
- [x] Refactor watcher to depend on `QuoteLifecycle` for quote concerns.
- [x] Refactor processor to depend on `QuoteLifecycle` for quote reads.
- [x] Remove operation remote-state fields from core mint operation model.
- [x] Phase operation remote-state read/write out of adapters while preserving
      old columns.
- [x] Update history remote state sourcing to canonical quote rows where
      practical.
- [x] Update legacy reconciliation to quote import plus operation prepare.
- [x] Remove React `useMintOperation().importQuote(...)`.
- [x] Update unit/integration tests.
- [x] Update migration docs and other references.
- [x] Run focused typecheck/tests for affected packages.
