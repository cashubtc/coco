# BOLT12 offers

Apply [Shared mint and melt lifecycle](quote-operations.md), including the reusable-quote claim
policy, to these flows.

## Receive Lightning through an offer: mint

```ts
const quote = await coco.quotes.mint.create({
  mintUrl,
  method: 'bolt12',
  unit: 'sat',
  description: 'Wallet deposit',
});
const offerToDisplay = quote.request;
```

Omitting `amount` creates an amountless offer. To request a fixed amount per payer payment, add
an amount such as `{ amount: 100, unit: 'sat' }` to quote creation. The offer remains reusable;
its fixed payment amount does not fix the size of every local Mint Operation.

Keep `{ mintUrl: quote.mintUrl, quoteId: quote.quoteId }` for the deposit screen. Refresh the quote
or observe `mint-quote:updated` for additional payments, then load `ops.mint.listByQuote(...)` to
show the claims. Use the shared lifecycle's app-controlled claim procedure only when partial
claims are required. One finalized operation does not complete a reusable offer for all time.

## Pay a BOLT12 offer: melt

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt12',
  methodData: { offer, amountSats: 1000 },
});
const prepared = await coco.ops.melt.prepare({ quote });
// Review the destination and fees, then await user confirmation.
const result = await coco.ops.melt.execute(prepared.id);
```

The example supplies an amount for an amountless offer. Omit `amountSats` when using an offer's
embedded amount. Pass sats to Coco; it performs the millisatoshi conversion for the underlying
BOLT12 request. Paying an offer again is a new user-approved payment with a new quote and
operation; retrying an interrupted payment resumes its existing operation.

**Done when:** the app handles fixed and amountless offers, repeated incoming payments update the
same quote, and outbound retries cannot become unintended repeat payments.
