# Onchain Mint Quote Watcher Plan

## Scope

Add first-class watching for reusable onchain mint quotes.

This plan depends on `MINT_QUOTE_WATCHER_GENERALIZATION_PLAN.md`. Onchain melt quote watching is
intentionally out of scope.

## Current State

- The generalization plan extracts watcher behavior into method-keyed policies.
- `SubscriptionKind` only includes `bolt11_mint_quote`, `bolt11_melt_quote`, and `proof_state`.
- `PollingTransport` only polls `bolt11_mint_quote`, `bolt11_melt_quote`, and `proof_state`.
- `MintOperationProcessor` already reacts to `mint-quote:updated` for `onchain` quotes, but no
  watcher currently produces long-lived onchain quote updates.
- `HybridTransport` state-based dedupe does not work for onchain mint quotes because they use
  `amount_paid` and `amount_issued` rather than `state`.

## Decisions

- Add `onchain_mint_quote` to the subscription protocol.
- Do not add `onchain_melt_quote` in this change.
  - Onchain melt quote watching remains a follow-up. Do not advertise or implement internal
    `onchain_melt_quote` behavior until the melt quote model, adapter, polling path, and operation
    flow support it end to end.
- Add an `onchain` mint quote watch policy.
- Watch all persisted, non-expired pending mint quotes on startup, including reusable onchain
  quotes with no pending operation.
- Keep onchain mint quote watches long-lived because those quotes are reusable.
- Stop onchain mint quote watching only when:
  - the quote expires,
  - the mint becomes untrusted,
  - the watcher is stopped,
  - or the quote is explicitly removed/deleted in a future lifecycle.
- Do not stop onchain mint quote watching when `amount_paid === amount_issued`; the quote is
  reusable and may receive more funds later.
- Keep using the existing per-mint polling scheduler.
- Treat polling as the baseline transport for every `SubscriptionKind`. WebSocket delivery is best
  effort and may reject a supported kind.
- If a mint rejects a WebSocket subscription request, keep the logical subscription alive and let
  polling continue serving it.
- Every `SubscriptionKind` added to the protocol must have concrete `PollingTransport` support.
- If `PollingTransport` receives an unknown or unimplemented kind, fail loudly instead of silently
  accepting a subscription that can never produce notifications.
- Dedupe quote notifications by normalized `amount_paid` and `amount_issued` when both are
  present.
- Continue deduping stateful payloads by `state`.
- If a payload has neither `state` nor both amount counters, bypass transport-level dedupe and let
  the domain watcher decide whether to drop or process it.
- Auto-claim onchain quote updates only when an internal service check reports locally claimable
  balance greater than zero.
- Keep startup pending quote claiming as the existing bounded sweep.
- Keep quote lifecycle event semantics unchanged for now, including emitting
  `mint-quote:updated` after idempotent onchain snapshot records.
- Preserve existing monotonic merge behavior for onchain counters when persisted counters are
  higher than an incoming snapshot.
- Do not add expiry timers in this change. Stop onchain quote watches when an expired snapshot is
  observed during startup, quote updates, or subscription payload handling.
- Keep generic polling errors retryable for now; do not infer quote expiry/deletion from transport
  errors.
- Keep `SubscriptionApi` unchanged. Onchain await-style public APIs are out of scope.
- Update user-facing docs to mention onchain mint support where method support is documented, but
  do not document internal subscription mechanics.

## Design

### Subscription Protocol

Update `SubscriptionKind`:

```ts
export type SubscriptionKind =
  | 'bolt11_mint_quote'
  | 'onchain_mint_quote'
  | 'bolt11_melt_quote'
  | 'proof_state';
```

Do not add onchain melt subscription behavior yet.

### Polling Transport

Add polling support for `onchain_mint_quote` using the existing mint adapter method:

```ts
mintAdapter.checkMintQuoteOnchain(mintUrl, quoteId)
```

The existing scheduler should remain unchanged:

- one queue per mint,
- one task at a time,
- interval enforced per mint,
- round-robin task re-enqueueing.

Polling is the required fallback for every protocol subscription kind. Therefore:

- validate subscription kinds at subscribe time;
- emit a JSON-RPC error response and do not enqueue if an unknown/unimplemented kind is received;
- throw or otherwise fail loudly for impossible unhandled task execution paths so tests and logs
  expose programmer errors.

Do not change retry behavior for normal mint/network errors. If an onchain quote poll fails because
the mint rejects the quote id, keep the current polling error logging/retry behavior.

### Hybrid Transport

Extend the notification signature helper from the generalization plan:

```text
if payload has amount_paid and amount_issued:
  signature = normalized(amount_paid) + ':' + normalized(amount_issued)
else if payload has state:
  signature = JSON.stringify(payload.state)
else:
  bypass dedupe
```

Normalize amount-like values with `Amount.from(value).toString()` where practical.
If normalization throws, bypass dedupe instead of falling back to raw JSON.

This avoids dropping later onchain updates where `state` is absent but `amount_paid` or
`amount_issued` changed.

Do not make domain validity decisions in `HybridTransport`. Incomplete stateless payloads should be
passed through and handled by the watcher.

### Subscription Manager

Review WebSocket subscribe error handling.

Current behavior deletes the active subscription when a subscribe request is rejected. That is too
strong for optional subscription kinds when hybrid polling can still serve the same logical
subscription.

The desired behavior:

- `SubscriptionManager` owns logical subscriptions.
- WebSocket delivery is best effort.
- Polling delivery remains active even if WebSocket rejects the kind.
- A rejected WebSocket subscribe response should clear only the pending request tracking entry. It
  should not delete the logical subscription or remove it from the mint's active subscription set.
- This applies to all current `SubscriptionKind` values because polling support is a protocol
  contract.

### Mint Operation Watcher

Add the onchain policy entry:

```ts
const mintQuoteWatchPolicies = {
  // existing bolt11 policy from the generalization plan
  onchain: {
    subscriptionKind: 'onchain_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
    shouldRecordPayload: (payload) =>
      payload.amount_paid !== undefined && payload.amount_issued !== undefined,
    shouldStopWatching: (payload) => isExpiredMintQuoteSnapshot(payload),
  },
} satisfies Partial<Record<MintMethod, MintQuoteWatchPolicy>>;
```

Behavior by method:

```text
bolt11:
  subscribe kind: bolt11_mint_quote
  record PAID and ISSUED updates
  stop on ISSUED or expiry

onchain:
  subscribe kind: onchain_mint_quote
  record snapshots with amount_paid / amount_issued
  stop only on expiry
```

Operation watch lifetime and quote watch lifetime must remain separate:

- finalizing an operation may unlink that operation from a quote watch,
- but it must not stop a reusable onchain quote watch.

Partial onchain payload handling:

- if `quote` is missing, drop the payload;
- if the snapshot is expired, stop watching even if amount counters are missing;
- if both `amount_paid` and `amount_issued` are present, persist the snapshot;
- otherwise drop the payload.

Keep the stop behavior method-specific for now rather than deriving it from a generic `reusable`
flag. A future refactor can generalize terminal/reusable semantics across methods.

### Mint Operation Processor

Inside the existing `claimingQuotes` guard, ask `MintOperationService` whether the quote currently
has locally claimable balance. Only call `claimMintQuote()` when that internal check returns true.
If the check throws, log and skip the claim attempt.

This avoids repeated no-op claims from long-lived polling updates.

Keep `MintOperationService.getLocallyClaimableQuoteAmount()` private. Add a narrow internal service
method for the processor, such as:

```ts
hasLocallyClaimableMintQuoteBalance(
  mintUrl: string,
  method: 'onchain',
  quoteId: string,
): Promise<boolean>
```

This method is service-internal and must not be exposed through `Manager`, `MintOpsApi`, package
docs as a public API, or other user-facing API surfaces.

Do not change `schedulePendingQuoteClaims()` in this plan. The startup claim sweep can continue
calling `claimPendingMintQuotes({ autoClaimRemaining: true })` directly.

## Affected Files

- `packages/core/infra/SubscriptionProtocol.ts`
- `packages/core/infra/PollingTransport.ts`
- `packages/core/infra/HybridTransport.ts`
- `packages/core/infra/SubscriptionManager.ts`
- `packages/core/services/watchers/MintOperationWatcherService.ts`
- `packages/core/services/watchers/MintOperationProcessor.ts`
- `packages/core/operations/mint/MintOperationService.ts`
- `packages/docs/pages/mint-operations.md`
- `packages/docs/pages/watchers-processors.md` or another existing docs page if that is the better
  local fit
- related unit tests under `packages/core/test/unit`

## Test Plan

Add or update unit tests for:

- `PollingTransport` polls `onchain_mint_quote` via `checkMintQuoteOnchain`.
- `PollingTransport` emits an error and does not enqueue unknown/unimplemented subscription kinds.
- `HybridTransport` dedupes by `amount_paid` and `amount_issued` when present.
- `HybridTransport` bypasses dedupe when neither `state` nor both amount counters are present.
- `HybridTransport` bypasses dedupe when amount normalization fails.
- `HybridTransport` still falls back to `state` for stateful payloads.
- `SubscriptionManager` keeps logical subscriptions active when WebSocket rejects an optional kind
  and polling continues to serve it.
- `MintOperationWatcherService` watches existing non-expired onchain mint quotes on startup.
- `MintOperationWatcherService` watches onchain quote updates emitted after startup.
- `MintOperationWatcherService` does not stop onchain quote watching when one operation finalizes.
- `MintOperationWatcherService` stops onchain quote watching when the quote expires.
- `MintOperationWatcherService` drops incomplete onchain payloads except for expiry-driven stop.
- `MintOperationWatcherService` does not stop onchain quote watching when
  `amount_paid === amount_issued`.
- `MintOperationProcessor` only schedules onchain claims when locally claimable balance is greater
  than zero.
- `MintOperationProcessor` logs and skips when the internal claimability check fails.
