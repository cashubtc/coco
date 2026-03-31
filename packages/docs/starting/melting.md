# Melting Tokens

Melting converts Cashu proofs back into sats by paying a Lightning invoice through the mint. Coco wraps this as a melt operation (saga) so fees are known up front and operations can be recovered if your app restarts.

## Pay a BOLT11 invoice

```ts
await coco.mint.addMint(mintUrl, { trusted: true });

const prepared = await coco.ops.melt.prepare({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

console.log('Quote:', prepared.quoteId);
console.log('Amount:', prepared.amount);
console.log('Fee reserve:', prepared.fee_reserve);
console.log('Needs swap:', prepared.needsSwap);

const result = await coco.ops.melt.execute(prepared.id);

if (result.state === 'finalized') {
  console.log('Change returned:', result.changeAmount);
  console.log('Effective fee:', result.effectiveFee);
}

if (result.state === 'pending') {
  const refreshed = await coco.ops.melt.refresh(result.id);
  console.log('Updated state:', refreshed.state);
}
```

`coco.ops.melt.prepare()` creates the melt quote, reserves proofs, and calculates any swap fees. `coco.ops.melt.execute()` pays the invoice immediately when possible or returns a `pending` operation that you can refresh later.

For newly finalized melts, `changeAmount` and `effectiveFee` show the actual settlement result. Older finalized melt records may not include those fields.

## Resume by quote

```ts
const operation = await coco.ops.melt.getByQuote(mintUrl, quoteId);

if (operation) {
  const result = await coco.ops.melt.execute(operation.id);
}
```

Use this when you only persisted the quote id (for example after a restart).

> For the full saga walkthrough, see [Melt Operations](../pages/melt-operations.md).
