# Minting Cashu Token

The process of swapping value for a Cashu token is called "minting". To mint
with Coco you prepare a mint operation, specifying a `mintUrl` and an `amount`.
Bare amounts default to sats; for custom units pass `{ amount, unit }`.

Before minting, ensure the mint is added and trusted (see [Adding a Mint](./adding-mints.md)):

```ts
// Add and trust the mint first
await coco.mint.addMint('https://minturl.com', { trusted: true });

// Create a mint operation (this also creates the remote quote)
const pendingMint = await coco.ops.mint.prepare({
  mintUrl: 'https://minturl.com',
  amount: 21,
  method: 'bolt11',
  methodData: {},
});
```

```ts
const customUnitMint = await coco.ops.mint.prepare({
  mintUrl: 'https://minturl.com',
  amount: { amount: 10, unit: 'usd' },
  method: 'bolt11',
});
```

The returned pending mint operation has a `request` field containing the BOLT11 payment request that needs to be paid before minting can happen. When [Watchers and Processors](../pages/watchers-processors.md) are activated (they are by default) Coco will automatically check whether the quote has been paid and redeem it automatically.
You can also execute the pending operation yourself after payment.

```ts
const pendingMint = await coco.ops.mint.prepare({
  mintUrl: 'https://minturl.com',
  amount: 21,
  method: 'bolt11',
  methodData: {},
});

console.log('pay this: ', pendingMint.request);
console.log('this is the quote id: ', pendingMint.quoteId);

coco.on('mint-op:finalized', (payload) => {
  if (payload.operationId === pendingMint.id) {
    console.log('This was paid!!');
  }
});
```

## BOLT12 offers

```ts
const pendingOffer = await coco.ops.mint.prepare({
  mintUrl: 'https://minturl.com',
  amount: 21,
  method: 'bolt12',
  methodData: {
    description: 'Mint 21 sats',
    amountless: true,
  },
});

console.log('pay this offer:', pendingOffer.request);
```

For BOLT12, Coco generates and stores the quote key in the keyring. Use
`listByQuote(mintUrl, quoteId)` if you need to inspect all operations for a
quote id.

For the full state machine and action reference, see
[Mint Operations](../pages/mint-operations.md). For multi-unit behavior, see
[Multi-Unit Support](../pages/multi-unit-support.md).
