# Multi-Unit Support

Coco supports Cashu units beyond `sat` when the mint advertises keysets and
quote methods for that unit. Bare amount inputs keep the historical default:

```ts
await coco.ops.send.prepare({ mintUrl, amount: 100 });
// Equivalent to { amount: 100, unit: 'sat' }
```

For a custom unit, pass the amount and unit together. Unit strings are trimmed
and lowercased by Coco before validation and persistence.

```ts
const quote = await coco.quotes.mint.create({
  mintUrl,
  amount: { amount: 25, unit: 'usd' },
  method: 'bolt11',
});

await coco.ops.mint.prepare({
  quote,
  amount: 25,
});

const preparedSend = await coco.ops.send.prepare({
  mintUrl,
  amount: { amount: 5, unit: 'usd' },
});
```

All operation records, events, history entries, tokens, proofs, and persisted
adapter rows include the normalized `unit`. Coco does not silently fall back to
sats for custom-unit operations. If the mint does not support the requested unit
for the selected keyset or quote method, the operation fails.

## Balances

Use unit-aware balance views when an app may hold more than one unit.

```ts
const byMintAndUnit = await coco.wallet.balances.byMintAndUnit();
const totals = await coco.wallet.balances.totalByUnit();

console.log(byMintAndUnit[mintUrl]?.usd?.spendable);
console.log(totals.sat?.total);
console.log(totals.usd?.total);
```

The legacy-shaped `byMint()` and `total()` helpers expose a single-unit view.
Without a unit filter they keep the default sat behavior. To read a custom
single-unit view, pass `units: ['usd']`.

```ts
const usdByMint = await coco.wallet.balances.byMint({ units: ['usd'] });
const usdTotal = await coco.wallet.balances.total({ units: ['usd'] });
```

## Receiving

Received token units are read from the token metadata and validated against the
token proofs. The receive operation keeps that unit through prepare, execute,
recovery, history, and saved proofs.

```ts
const prepared = await coco.ops.receive.prepare({ token });
console.log(prepared.amount, prepared.unit);

await coco.ops.receive.execute(prepared.id);
```

## Melting

Melt operation preparation uses the invoice/request unit and continues to default
bare amounts to sats.

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

const prepared = await coco.ops.melt.prepare({
  mintUrl,
  method: 'bolt11',
  quoteId: quote.quoteId,
});

console.log(prepared.amount, prepared.unit, prepared.fee_reserve);
await coco.ops.melt.execute(prepared.id);
```

## Payment Requests

Payment requests carry their own unit. `paymentRequests.parse()` returns the
normalized `unit`, finds payable mints with spendable balance in that unit, and
`prepare()` validates any provided amount against the request unit.

```ts
const request = await coco.paymentRequests.parse(encodedRequest);

const transaction = await coco.paymentRequests.prepare(request, {
  mintUrl: request.payableMints[0],
  amount: request.amount ? undefined : { amount: 5, unit: request.unit },
});

await coco.paymentRequests.execute(transaction);
```

Incoming payment requests use the same amount input shape. Bare amounts create
sat requests unless `unit` is provided; custom-unit requests should keep amount
and unit coupled:

```ts
await coco.paymentRequests.incoming.create({
  amount: { amount: 5, unit: 'usd' },
  mints: ['https://mint.url'],
});
```

## Restore And Sweep

`wallet.restore()` and `wallet.sweep()` process every keyset unit advertised by
the mint by default. Pass a unit filter when restoring or sweeping a subset.

```ts
await coco.wallet.restore(mintUrl);
await coco.wallet.restore(mintUrl, { units: ['usd'] });

await coco.wallet.sweep(mintUrl, oldSeed);
await coco.wallet.sweep(mintUrl, oldSeed, { units: ['usd'] });
```

Legacy proofs without stored unit metadata are treated as `sat` when no keyset
unit can be recovered.
