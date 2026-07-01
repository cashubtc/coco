# Melting Tokens

Melting converts Cashu proofs back into sats by paying through the mint. Coco wraps this as a melt operation (saga) so fees are known up front and operations can be recovered if your app restarts.

## Pay a BOLT11 invoice

```ts
await coco.mint.addMint(mintUrl, { trusted: true });

const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

const prepared = await coco.ops.melt.prepare({
  quote,
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
  const paidQuote = await coco.quotes.melt.awaitPaid({
    mintUrl,
    quoteId: prepared.quoteId,
  });
  console.log('Updated state:', paidQuote.state);

  // Only needed if the default melt watcher/settlement processor is disabled.
  const finalized = await coco.ops.melt.refresh(prepared.id);
  if (finalized.state === 'finalized') {
    console.log('Change returned:', finalized.changeAmount);
    console.log('Effective fee:', finalized.effectiveFee);
  }
}
```

`coco.quotes.melt.create()` creates the melt quote without creating history. `coco.ops.melt.prepare()` reserves proofs and calculates any swap fees. `coco.ops.melt.execute()` pays the invoice immediately when possible or returns a `pending` operation that you can refresh later.

`coco.quotes.melt.awaitPaid()` only waits for the canonical quote to reach
`PAID`. With the default `initializeCoco()` wiring, `MeltQuoteWatcherService` and
`MeltSettlementProcessor` settle pending operations in the background. Manual
`coco.ops.melt.refresh(prepared.id)` is only needed if you disable those services
or wire `Manager` manually without them.

For newly finalized melts, `changeAmount` and `effectiveFee` show the actual settlement result. Older finalized melt records may not include those fields.

## Resume by quote

```ts
const operation = await coco.ops.melt.getByQuote({ mintUrl, quoteId });

if (operation) {
  const result = await coco.ops.melt.execute(operation.id);
}
```

Use this when you persisted the quote identity but not the operation id. Quote
identity is `{ mintUrl, quoteId }`; the stored canonical quote supplies the
method.

## Pay a BOLT12 offer

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt12',
  methodData: { offer, amountSats: 1000 },
});

const prepared = await coco.ops.melt.prepare({
  quote,
});

const result = await coco.ops.melt.execute(prepared.id);
```

`amountSats` is optional and is intended for amountless BOLT12 offers.
Use `listByQuote({ mintUrl, quoteId })` when a quote id may map to more than
one operation.

## Pay an onchain address

Onchain melts use NUT-30 fee options. The quote advertises one or more
`fee_options`, and the operation stores the selected `feeIndex`.

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'onchain',
  methodData: { address, amountSats: 21_000 },
});

const prepared = await coco.ops.melt.prepare({
  quote,
  feeIndex: quote.fee_options[0].fee_index,
});

const executed = await coco.ops.melt.execute(prepared.id);

if (executed.state === 'pending') {
  const paidQuote = await coco.quotes.melt.awaitPaid({
    mintUrl,
    quoteId: prepared.quoteId,
  });
  console.log('Updated state:', paidQuote.state);

  // Only needed if the default melt watcher/settlement processor is disabled.
  const finalized = await coco.ops.melt.refresh(prepared.id);
  if (finalized.state === 'finalized') {
    console.log('Change returned:', finalized.changeAmount);
    console.log('Effective fee:', finalized.effectiveFee);
  }
}
```

Pass one of the advertised `quote.fee_options[].fee_index` values. Onchain melts
are usually asynchronous, but intramint melt/mint settlement can finalize
immediately; handle both `pending` and `finalized` execution results.

> For the full saga walkthrough, see [Melt Operations](../pages/melt-operations.md).
