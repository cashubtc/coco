# Mint Operation Finalization Plan

## Scope

Adjust mint operation finalization so successful proof persistence is independent from onchain quote
counter freshness.

This plan covers `MintOperationService` behavior and related tests. Quote freshness and recurring
remote sync belong to the watcher plan.

## Current State

- `MintOperationService.executeReadyOperation()` saves proofs, then calls
  `ensureReusableQuoteIssuanceObserved()` for onchain operations before finalizing.
- `recoverExecutingOperation()` also calls `ensureReusableQuoteIssuanceObserved()` after recovered
  outputs are saved.
- `ensureReusableQuoteIssuanceObserved()` refreshes the onchain quote and blocks finalization if the
  refreshed `amount_issued` does not cover locally finalized siblings plus the current operation.
- This couples operation finalization to remote quote counter freshness.

## Core Invariant

Signed persisted proofs are the source of truth for operation success.

```text
if signed proofs are saved:
  finalize the mint operation
```

`amount_issued` is quote accounting. It is useful for planning future claims, but it should not
decide whether already-saved proofs are valid.

## Decisions

- `MintOperationService` must not synchronously refresh an onchain quote just to finalize an
  operation with saved proofs.
- Delete `ensureReusableQuoteIssuanceObserved()` if no remaining non-proof recovery path needs it.
- Keep remote quote checks in method handlers where they are needed to decide what happened before
  proofs are available.
- Add a service-only claimable-balance method for watcher/processor use.
- Do not expose the claimable-balance method through public APIs yet.
- Keep local claimable calculation conservative by accounting for local finalized and executing
  sibling operations.

## Desired Finalization Flow

### Direct Execute Success

```text
handler.execute() returns ISSUED with proofs
save proofs
finalize operation
emit mint-op:finalized
```

No quote refresh is required in this path.

### Already Issued / Recovery

If proofs can be recovered and saved:

```text
recover or restore signed outputs
save proofs
finalize operation
emit mint-op:finalized
```

No quote refresh is required after proof recovery.

If proofs cannot be recovered, remote checks remain useful to decide whether the operation should
return to pending, fail, or stay recoverable. That logic should stay in method handlers such as
`MintOnchainHandler.recoverExecuting()`.

## Claimable Balance Method

Add a service-only method on `MintOperationService`, for example:

```ts
async getClaimableMintQuoteAmount(
  mintUrl: string,
  method: MintMethod,
  quoteId: string,
): Promise<Amount>
```

Behavior:

- return zero for non-onchain quotes unless a future caller needs bolt11 support,
- load the persisted quote,
- return zero if missing, expired, or not reusable/claimable,
- use existing local accounting from `getLocallyClaimableQuoteAmount()`.

This method is for internal watcher/processor orchestration only. Do not add it to `MintOpsApi`.

## Local Accounting Rules

For onchain quotes:

```text
remote available = amount_paid - effective_issued
effective_issued = max(remote amount_issued, locally finalized sibling amount)
claimable = remote available - locally executing sibling amount
```

This protects the same client from double-claiming while the quote watcher catches up.

It does not need to perfectly repair stale remote quote counters. The watcher owns remote quote
freshness, and the mint remains authoritative if a later claim overreaches.

## Review Comment Resolution

The previous review suggested strengthening the refreshed `amount_issued` check to include prior
remote issuance. The final design removes the blocking refreshed-counter check instead.

Reason:

- if proofs are saved, the operation succeeded,
- a stale quote counter can only affect future availability estimation,
- future availability is handled by watcher sync plus conservative local accounting,
- mint-side validation remains authoritative for later claims.

## Affected Files

- `packages/core/operations/mint/MintOperationService.ts`
- `packages/core/services/watchers/MintOperationProcessor.ts`
- `packages/core/test/unit/MintOperationService.test.ts`
- `packages/core/test/unit/MintQuoteProcessor.test.ts` or watcher/processor tests as needed

## Test Plan

Add or update tests for:

- onchain execute success finalizes after proofs are saved without calling `fetchRemoteQuote`.
- onchain recovery finalizes after recovered proofs are saved without calling `fetchRemoteQuote`.
- stale `amount_issued` does not block finalization when proofs exist.
- local claimable amount subtracts finalized sibling operations when quote data is stale.
- local claimable amount subtracts executing sibling operations.
- public `MintOpsApi` remains unchanged.
- processor uses service claimable-balance method before scheduling onchain auto-claim.

## Non-Goals

- Do not add public API for claimable quote amount.
- Do not implement onchain melt quote support.
- Do not introduce a new quote dirty event.
- Do not add a separate polling scheduler or custom interval class for onchain quotes.

