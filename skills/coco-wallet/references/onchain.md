# Onchain payments

Apply [Shared mint and melt lifecycle](quote-operations.md), including the reusable-quote claim
policy, to these flows.

## Receive onchain: mint

```ts
const quote = await coco.quotes.mint.create({ mintUrl, method: 'onchain', unit: 'sat' });
const addressToDisplay = quote.request;
```

Onchain mint quote creation takes a unit, not a deposit amount. Retain the quote identity and
display its address. The mint reports recognized deposits through `amountPaid` and issuance
through `amountIssued`. Refresh or observe the canonical quote, and track the resulting Mint
Operations through `ops.mint.listByQuote(...)`.

The address can receive more than one payment. Keep the quote observable after a claim finalizes;
use the common partial-claim procedure when the app needs to choose claim amounts. A detected
transaction or a local confirmation estimate alone is not spendable ecash: show funds as
received after Coco finalizes the corresponding Mint Operation.

## Pay an onchain address: melt

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'onchain',
  methodData: { address, amountSats: 21_000 },
});
// Show quote.fee_options and let the user choose an advertised fee_index.
const selectedOption = quote.fee_options.find((option) => option.fee_index === selectedFeeIndex);
if (!selectedOption) throw new Error('Choose an available onchain fee option');

const prepared = await coco.ops.melt.prepare({ quote, feeIndex: selectedOption.fee_index });
// Review the destination and fees, then await user confirmation.
const result = await coco.ops.melt.execute(prepared.id);
```

Display each option's `fee_reserve` and `estimated_blocks`. `feeIndex` is the advertised
`fee_index`, not its position in the array; it is required for onchain preparation. Treat block
estimates as estimates. Handle both pending and immediate finalization, including intramint
settlement, and use the existing operation for subsequent checks.

**Done when:** repeated deposits remain observable, the selected advertised fee option reaches
preparation, and an asynchronous withdrawal resumes without initiating a second payment.
