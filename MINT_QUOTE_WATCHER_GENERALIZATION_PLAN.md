# Mint Quote Watcher Generalization Plan

## Scope

Refactor the existing mint quote watcher code so quote watching is method-policy driven.

This change must preserve existing `bolt11` behavior. It must not add `onchain_mint_quote`,
onchain polling, onchain auto-claim behavior, or onchain quote startup watching.

## Goal

Make the next mint quote watching method an additive change:

- add a subscription kind,
- add any needed polling adapter case,
- add quote conversion/import support,
- add one watch policy entry.

## Current State

- `MintOperationWatcherService` hard-codes `bolt11` checks in startup loading, operation watching,
  quote watching, payload persistence, and watch stopping.
- `HybridTransport` deduplicates subscription notifications directly by `payload.state`.
- `MintMethodHandler` already provides a generic method registry for operation behavior, but quote
  watcher behavior is not yet centralized by method.

## Decisions

- Add a method-keyed mint quote watch policy table.
- Keep the policy table private to `MintOperationWatcherService.ts` for this preparation change.
- Start with a `bolt11` policy only. Methods without a policy must be skipped.
- Keep bolt11 behavior unchanged:
  - subscribe to `bolt11_mint_quote`,
  - record only `PAID` and `ISSUED` updates,
  - stop watching on `ISSUED` or expiry,
  - stop operation-bound watches when the operation reaches executing/finalized.
- Load all pending mint quotes on startup and policy-filter them in the watcher, instead of asking
  storage only for `bolt11` quotes. This keeps the next watched method additive while still doing
  nothing for methods without a policy.
- Keep quote watch lifetime and operation watch lifetime modeled separately. This is required for
  reusable quotes: operation finalization must remove only operation interest, while quote interest
  can remain active until the quote itself becomes terminal.
- Support multiple operation interests per quote watch.
- Group subscriptions by mint URL and subscription kind.
- Extract notification signature logic so the current state-based dedupe remains the default.
  Future methods can extend this without replacing the dedupe path.

## Design

### Watch Policy

Use one shared quote-watching path backed by method-specific watch policies.

The policy table should separate the dimensions that tend to vary by mint method:

```ts
interface MintQuoteWatchPolicy<M extends MintMethod = MintMethod> {
  subscriptionKind: SubscriptionKind;
  getPayloadQuoteId(payload: MintMethodQuoteSnapshot<M>): string | undefined;
  shouldRecordPayload(payload: MintMethodQuoteSnapshot<M>): boolean;
  shouldStopWatching(payload: MintMethodQuoteSnapshot<M>): boolean;
}

const mintQuoteWatchPolicies = {
  bolt11: {
    subscriptionKind: 'bolt11_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
    shouldRecordPayload: (payload) => payload.state === 'PAID' || payload.state === 'ISSUED',
    shouldStopWatching: (payload) =>
      payload.state === 'ISSUED' || isExpiredMintQuoteSnapshot(payload),
  },
} satisfies Partial<Record<MintMethod, MintQuoteWatchPolicy>>;
```

The first implementation should avoid speculative behavior for methods that are not watched yet.
If a quote method has no policy, the watcher should skip it.

The policy helper for expiry should be private to the watcher:

```ts
function isExpiredMintQuoteSnapshot(snapshot: { expiry?: number | null }): boolean {
  return (
    snapshot.expiry !== null &&
    snapshot.expiry !== undefined &&
    snapshot.expiry * 1000 <= Date.now()
  );
}
```

Expiry values are Unix seconds. `null` and `undefined` mean "not expired" for watch policy
purposes.

### Watcher Flow

Refactor `MintOperationWatcherService` so it:

- finds the policy for each quote or operation method,
- skips methods with no policy, including `onchain` during this change,
- loads startup pending quotes with `getPendingMintQuotes()` and filters them by policy,
- groups watchable quotes by mint URL and subscription kind,
- subscribes using the policy's `subscriptionKind`,
- extracts the payload quote id first with `getPayloadQuoteId()`,
- records snapshots only when `shouldRecordPayload()` returns true,
- stops quote watches only when `shouldStopWatching()` returns true.

For subscription payloads, the callback order should be:

```ts
const quoteId = policy.getPayloadQuoteId(payload);
if (!quoteId) return;

if (policy.shouldRecordPayload(payload)) {
  await recordMintQuoteSnapshot(mintUrl, method, payload);
}

if (policy.shouldStopWatching(payload)) {
  await stopWatching(toKey(mintUrl, method, quoteId));
}
```

For `mint-quote:updated` events, convert the stored quote to a method snapshot and check
`shouldStopWatching()` before starting or refreshing a watch. This generalizes the current
`ISSUED` short-circuit and also prevents starting watches for already-expired quotes.

`watchMintQuotes()` should also skip stored quote snapshots that are already terminal according to
the method policy. Operation-bound watch setup should policy-gate by method, but it should not
invent a full quote snapshot from operation fields just to run stop logic.

### Watch Interests

Model subscriptions separately from the reasons a quote is being watched.

Use an internal watch record keyed by:

```text
${mintUrl}::${method}::${quoteId}
```

The record should be able to represent:

- canonical quote interest, from startup quote loading or `mint-quote:updated`;
- operation interest, from one or more pending mint operations;
- the per-key stop function for a shared batch subscription.

The current one-operation-per-key maps should be replaced with a structure equivalent to:

```ts
interface QuoteWatchRecord {
  mintUrl: string;
  method: MintMethod;
  quoteId: string;
  subscriptionKind: SubscriptionKind;
  canonical: boolean;
  operationIds: Set<string>;
  stop?: UnsubscribeHandler;
}
```

Keep an `operationId -> quote key` index for efficient operation-interest removal.

Interest handling rules:

- If a quote is already subscribed because of operation interest, a later canonical quote update
  should add canonical interest without creating a second subscription.
- If a quote is already subscribed because of canonical interest, a later pending operation should
  add operation interest without creating a second subscription.
- `mint-op:executing` and `mint-op:finalized` remove only that operation id from the quote watch.
- The actual unsubscribe happens only when no canonical interest and no operation ids remain.
- A policy terminal stop, such as `ISSUED` for `bolt11` or expiry, tears down the whole quote watch
  and clears all interests for that quote key.
- When a mint becomes untrusted or the watcher stops, all watch records for that mint are torn down.

`watchMintQuotes()` should accept explicit interest metadata instead of inferring ownership from the
quote objects. For example:

- startup canonical quotes: `watchMintQuotes(quotes, { canonical: true })`;
- quote update event: `watchMintQuotes([quote], { canonical: true })`;
- pending operations: build quote refs and call `watchMintQuotes(refs, { operationIdsByKey })`.

When adding operation interest, add it before subscription setup when the watch record already
exists. For new records, rollback the new interests if subscription creation fails so failed
subscribes do not leave phantom watches.

### Batch Subscriptions

Preserve the existing batch behavior.

Within each `(mintUrl, subscriptionKind)` group, subscribe in chunks of up to 100 quote ids. Each
quote watch record should store a per-key stop function that removes only that quote id from the
batch's local `remaining` set. The shared batch unsubscribe should be called only after all quote
ids in that batch have stopped.

### Notification Dedupe

Extract `HybridTransport` notification signature creation into a helper. For this generalization
change, it should remain behavior-preserving:

```text
signature = JSON.stringify(payload.state)
```

The helper can start as:

```ts
private getNotificationSignature(payload: { state?: unknown }): string {
  return JSON.stringify(payload.state);
}
```

Rename the dedupe storage to `lastNotificationSignatureByKey` if convenient; the behavior should
remain unchanged.

The onchain follow-up will extend this helper for amount-counter payloads.

## Affected Files

- `packages/core/infra/HybridTransport.ts`
- `packages/core/services/watchers/MintOperationWatcherService.ts`
- related unit tests under `packages/core/test/unit`

## Test Plan

Add or update unit tests for:

- `MintOperationWatcherService` loads all pending mint quotes on startup, then watches existing
  pending `bolt11` mint quotes.
- `MintOperationWatcherService` still watches `bolt11` quote updates emitted after startup.
- `MintOperationWatcherService` still records `PAID` and `ISSUED` `bolt11` payloads.
- `MintOperationWatcherService` still stops `bolt11` quote watching on `ISSUED`.
- `MintOperationWatcherService` stops `bolt11` quote watching when a payload is expired, even when
  the payload is not record-worthy.
- `MintOperationWatcherService` does not subscribe for methods with no policy, including `onchain`
  pending quotes and pending operations in this preparation change.
- `MintOperationWatcherService` creates only one subscription when canonical and operation interest
  point at the same quote.
- `MintOperationWatcherService` does not unsubscribe when one operation interest is removed while
  canonical interest or another operation interest remains.
- `MintOperationWatcherService` tears down all interests when the policy says the quote itself is
  terminal.
- `HybridTransport` still dedupes stateful payloads by `state`.

Prefer behavior-level assertions through `subscribe`, `unsubscribe`, and subscription callbacks.
Avoid tests that inspect private watcher maps.
