# Minting Cashu Token

The process of swapping sats for Cashu token is called "minting". To mint with Coco you need to create a mint quote, specifying a `mintUrl` and an `amount` in Sats.

Before minting, ensure the mint is added and trusted (see [Adding a Mint](./adding-mints.md)):

```ts
// Add and trust the mint first
await coco.mint.addMint('https://minturl.com', { trusted: true });

// Create a mint quote
const mintQuote = await coco.quotes.createMintQuote('https://minturl.com', 21);
```

The returned `MintQuoteReponse` has a "request" field that contains a BOLT11 payment request that needs to be paid before minting can happen. When [Watchers and Processors](../pages/watchers-processors.md) are activated (they are by default) Coco will automatically check whether the quote has been paid and redeem it automatically.
You can use the event system to get notified once a quote was redeemed.

```ts
const mintQuote = await coco.quotes.createMintQuote('https://minturl.com', 21);

console.log('pay this: ', mintQuote.request);
console.log('this is the quotes id: ', mintQuote.quote);

coco.on('mint-quote:redeemed', (payload) => {
  if (payload.quoteId === mintQuote.quote) {
    console.log('This was paid!!');
  }
});
```
