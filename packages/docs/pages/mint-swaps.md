# Mint Swaps

Mint Swaps move an exact amount from one trusted mint to another by coordinating a destination
mint quote with a source melt. The parent operation is durable: Coco records every authorization
before remote work and recovers incomplete swaps after restart.

Mint Swap support depends on the storage adapter. Check it before presenting the feature:

```ts
if (!coco.ops.mintSwap.diagnostics.isAvailable()) {
  // The custom adapter does not implement durable Mint Swap persistence.
}
```

Built-in SQLite, Expo SQLite, and IndexedDB adapters provide the capability. Custom adapters may
omit it; the rest of Coco continues to work, but Mint Swap commands reject before reserving proofs
or making a network request.

Both mints must be trusted and advertise enabled `sat` BOLT11 support for their respective NUT-04
and NUT-05 roles. The destination must also support locked mint quotes (NUT-20), and safe recovery
uses the quote, proof-state, and output-restore capabilities advertised by the mints.

## Prepare and execute

```ts
const prepared = await coco.ops.mintSwap.prepare({
  sourceMintUrl,
  destinationMintUrl,
  amount: 100,
  requiredDispatchWindowSeconds: 90,
});

// Present prepared fees and expiry information for confirmation.
const operation = await coco.ops.mintSwap.execute(prepared.id);
const completed = await coco.ops.mintSwap.waitFor(operation.id, { timeoutMs: 120_000 });
```

Preparation is non-dispatching: it creates and persists the child plan, but does not authorize the
source payment. `execute()` validates the saved plan and dispatch window immediately before it
authorizes the source melt.

The main states are `preparing`, `prepared`, `source_inflight`, `destination_funded`, `issuing`,
`completed`, `cancelled`, `failed`, and `needs_attention`. Render `needs_attention` as a durable
manual-recovery outcome; do not retry it automatically.

The destination receives the requested amount exactly. The source debit includes the destination
amount plus the source payment, input, and preparation fees, minus any returned melt change and
pre-swap keep amount. The prepared plan records minimum and maximum source-debit bounds so the UI
can ask for confirmation before dispatch.

Mint Swap is a recoverable saga across two independent mints, not one atomic network transaction.
Once the source reports payment, temporary destination failure can leave the operation durably
funded until issuance succeeds. Coco retries from persisted evidence; contradictory or insufficient
evidence moves the operation to `needs_attention` instead of guessing.

## Recovery and cancellation

Coco automatically recovers active swaps on startup when the adapter is capable. Explicit recovery
is also available for recovery screens:

```ts
await coco.ops.mintSwap.recovery.run();
const active = await coco.ops.mintSwap.listActive();
const latest = await coco.ops.mintSwap.reconcile(operationId);
```

`cancel()` immediately cancels work that has not been dispatched. After dispatch it records a
cancellation request, but recovery must still establish the remote outcome before value can be
settled safely.

`waitFor()` resolves only for `completed`. It rejects with `MintSwapSettlementError` for
`cancelled`, `failed`, or `needs_attention`, and also supports an abort signal and timeout.

## Events and history

Subscribe through `coco.on(...)` to lifecycle events such as `mint-swap-op:prepared`,
`mint-swap-op:completed`, and `mint-swap-op:needs-attention`. Events are backed by a durable outbox,
so listener delivery can retry after a process interruption.

History contains one sanitized `mint-swap` parent entry. Owned mint and melt child operations are
suppressed from the public history projection to avoid double counting.
