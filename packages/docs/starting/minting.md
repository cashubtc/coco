# Minting Cashu Token

The process of swapping sats for Cashu token is called "minting". To mint with Coco you prepare a mint operation, specifying a `mintUrl` and an `amount` in sats.

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

For the full state machine and action reference, see
[Mint Operations](../pages/mint-operations.md).
