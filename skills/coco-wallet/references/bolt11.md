# BOLT11 invoices

Apply [Shared mint and melt lifecycle](quote-operations.md) to these flows.

## Receive Lightning: mint

```ts
const quote = await coco.quotes.mint.create({ mintUrl, amount: 100, method: 'bolt11' });
const pendingMint = await coco.ops.mint.prepare({ quote, amount: 100 });
const invoiceToDisplay = pendingMint.request;
```

Display the invoice and track `pendingMint.id`. BOLT11 quotes have a fixed amount: prepare the
full quote amount, using the quote's stored unit. A custom-unit quote uses a unit-coupled amount
when creating the quote and a bare `AmountLike` when preparing the mint operation, as described
in [Wallet basics](wallet-basics.md).

Wait for the operation's finalized state before showing the funds as received. The default
processor claims paid quotes, including those observed after restart.

## Pay Lightning: melt

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});
const prepared = await coco.ops.melt.prepare({ quote });
// Review the destination and fees, then await user confirmation.
const result = await coco.ops.melt.execute(prepared.id);
```

For an amountless invoice, provide the user-selected `methodData.amountSats` when requesting the
melt quote if supported by the mint. That input is in sats; Coco handles the protocol conversion.
Use the canonical quote and prepared operation to display the resulting amount and fees.

**Done when:** incoming invoices finalize into proofs and outgoing payments handle both pending
and immediate finalization, including a resumed payment after a lost response.
