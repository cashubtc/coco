# Melting Tokens

Melting converts Cashu proofs back into sats by paying a Lightning invoice through the mint. Coco wraps this as a melt operation (saga) so fees are known up front and operations can be recovered if your app restarts.

## Pay a BOLT11 invoice

```ts
await coco.mint.addMint(mintUrl, { trusted: true });

const prepared = await coco.quotes.prepareMeltBolt11(mintUrl, invoice);

console.log('Quote:', prepared.quoteId);
console.log('Amount:', prepared.amount);
console.log('Fee reserve:', prepared.fee_reserve);
console.log('Needs swap:', prepared.needsSwap);

const result = await coco.quotes.executeMelt(prepared.id);

if (result.state === 'pending') {
  const decision = await coco.quotes.checkPendingMelt(result.id);
  console.log('Pending decision:', decision);
}
```

`prepareMeltBolt11` creates the melt quote, reserves proofs, and calculates any swap fees. `executeMelt` pays the invoice immediately when possible or returns a `pending` operation that you can check later.

## Resume by quote

```ts
const result = await coco.quotes.executeMeltByQuote(mintUrl, quoteId);
```

Use this when you only persisted the quote id (for example after a restart).

> For the full saga walkthrough, see [Melt Operations](../pages/melt-operations.md).
