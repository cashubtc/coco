# Minting Cashu Token

The process of swapping value for a Cashu token is called "minting". To mint
with Coco you first create a canonical mint quote, then prepare a mint operation
from that quote. The mint operation amount uses the canonical quote's stored
unit.

Before minting, ensure the mint is added and trusted (see [Adding a Mint](./adding-mints.md)):

```ts
// Add and trust the mint first
await coco.mint.addMint('https://minturl.com', { trusted: true });

// Create a quote first
const quote = await coco.quotes.mint.create({
  mintUrl: 'https://minturl.com',
  amount: 21,
  method: 'bolt11',
});

// Prepare an operation from the quote
const pendingMint = await coco.ops.mint.prepare({
  quote,
  amount: 21,
});
```

```ts
const customUnitQuote = await coco.quotes.mint.create({
  mintUrl: 'https://minturl.com',
  amount: { amount: 10, unit: 'usd' },
  method: 'bolt11',
});

const customUnitMint = await coco.ops.mint.prepare({
  quote: customUnitQuote,
  amount: 10,
});
```

The canonical quote and returned pending mint operation both expose `request`,
the BOLT11 payment request that needs to be paid before minting can happen. When
[Watchers and Processors](../pages/watchers-processors.md) are activated (they
are by default) Coco will automatically check whether the quote has been paid
and redeem it automatically.
You can also execute the pending operation yourself after payment.

```ts
const quote = await coco.quotes.mint.create({
  mintUrl: 'https://minturl.com',
  amount: 21,
  method: 'bolt11',
});

const pendingMint = await coco.ops.mint.prepare({
  quote,
  amount: 21,
});

console.log('pay this: ', pendingMint.request);
console.log('this is the quote id: ', pendingMint.quoteId);

coco.on('mint-op:finalized', (payload) => {
  if (payload.operationId === pendingMint.id) {
    console.log('This was paid!!');
  }
});

await coco.quotes.mint.awaitClaimable({
  mintUrl: 'https://minturl.com',
  quoteId: pendingMint.quoteId,
});

await coco.ops.mint.execute(pendingMint.id);
```

Reusable onchain and BOLT12 mint quotes are created through the same quote API.
The quote request is the address, offer, or payment request to fund. Refresh the
quote to observe new incoming amount, then prepare one or more mint operations
against the same quote ID.

```ts
const quote = await coco.quotes.mint.create({
  mintUrl: 'https://minturl.com',
  method: 'onchain',
  unit: 'sat',
});

console.log('fund this: ', quote.request);

const refreshed = await coco.quotes.mint.awaitClaimable({
  mintUrl: 'https://minturl.com',
  quoteId: quote.quoteId,
});

const claimable = refreshed.quoteData.amountPaid.subtract(refreshed.quoteData.amountIssued);

if (!claimable.isZero()) {
  const pendingOnchainMint = await coco.ops.mint.prepare({
    quote,
    amount: 5,
  });

  await coco.ops.mint.finalize(pendingOnchainMint.id);
}
```

BOLT12 uses the same quote-first shape. A fixed amount on a BOLT12 quote is
encoded into the reusable offer and constrains each payer payment, but the
wallet still chooses how much to mint from the claimable quote balance.

```ts
const offerQuote = await coco.quotes.mint.create({
  mintUrl: 'https://minturl.com',
  method: 'bolt12',
  unit: 'sat',
  amount: { amount: 21, unit: 'sat' },
  description: 'Mint 21 sats',
});

console.log('pay this offer:', offerQuote.request);

await coco.quotes.mint.awaitNextPayment({
  mintUrl: 'https://minturl.com',
  quoteId: offerQuote.quoteId,
});

const pendingOfferMint = await coco.ops.mint.prepare({
  quote: offerQuote,
  amount: 10,
});
```

`quoteId` identifies the remote quote, not a local mint operation. Store
`pendingMint.id`, `pendingOnchainMint.id`, or `pendingOfferMint.id` when you
need to resume a specific operation later.

For the full state machine and action reference, see
[Mint Operations](../pages/mint-operations.md). For multi-unit behavior, see
[Multi-Unit Support](../pages/multi-unit-support.md).
