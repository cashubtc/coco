# Wallet flows

Read the sections for the requested features. Examples assume an initialized `coco`, a chosen
`mintUrl`, and validated inputs. The UI supplies the review and confirmation steps described
between API calls.

## Mint trust

Use `coco.mint.addMint(mintUrl)` to retain a Known Mint and inspect its information. After the
user approves it, call `coco.mint.trustMint(mintUrl)`. An explicitly chosen and approved mint can
be added with `{ trusted: true }`. Discover the selection with `getAllTrustedMints()`.

For received tokens, decode with `coco.wallet.decodeToken(encodedToken)`, show the mint and unit,
and resolve trust before preparing the receive. Treat token decoding as validation of the encoded
input, not proof that its value is still spendable. Do not silently trust a mint supplied by a
pasted token, QR code, or payment request.

## Amounts, balances, and history

For APIs accepting `UnitAmountLike`, such as `ops.send.prepare()` and `quotes.mint.create()`,
bare amounts default to sats when no explicit or contextual unit is supplied. Use unit-coupled
inputs such as `{ amount: 5, unit: 'usd' }` on those APIs to select a custom unit.

`ops.mint.prepare({ quote, amount })` instead accepts `AmountLike` and derives the unit from the
canonical stored quote. With a USD quote, `{ quote: usdQuote, amount: 25 }` means 25 USD units.
Pass the amount alone in that field; a unit-coupled object is not accepted. Label and validate
the mint amount using the quote's unit.

Validate positive integer amounts in the selected unit; retain Coco's `Amount` representation
for arithmetic and use `.toString()` for display rather than coercing large values through
JavaScript `number`.

```ts
const byMint = await coco.wallet.balances.byMint();
const balance = byMint[mintUrl];
const spendableText = balance?.spendable.toString() ?? '0';
const history = await coco.history.getPaginatedHistory(0, 25);
```

Balance snapshots contain `spendable`, `reserved`, and `total`. Check spendable funds at the
selected mint; another mint's funds do not cover that payment. Preparation remains authoritative
if a displayed balance becomes stale. Refresh balance/history views from Coco events or React
derived-data hooks.

For multiple units, read [Multi-Unit Support](https://cashubtc.github.io/coco/pages/multi-unit-support).
Use `byMintAndUnit()` / `totalByUnit()` and show totals separately by unit. The default `byMint()`
and `total()` views are sat-scoped.

## Receive ecash

After the mint trust decision:

```ts
const prepared = await coco.ops.receive.prepare({ token: encodedToken });
// Show prepared.amount, prepared.unit, and prepared.fee; await user confirmation.
const received = await coco.ops.receive.execute(prepared.id);
```

Persist or retain `prepared.id` for resuming this screen. Render completion from the finalized
operation, not from decoding or scanning the token. If the user abandons a prepared receive,
call `coco.ops.receive.cancel(prepared.id)`.

## Send ecash

```ts
const prepared = await coco.ops.send.prepare({ mintUrl, amount: 100 });
// Show prepared.amount, prepared.unit, prepared.fee, and prepared.inputAmount.
// After user confirmation:
const { operation, token } = await coco.ops.send.execute(prepared.id);
const encodedToken = coco.wallet.encodeToken(token);
```

`token` is a Token object; encode it before displaying it as text, copying it, or generating a QR.
The resulting operation is `pending`: the token is ready to share but the recipient has not yet
been confirmed to have claimed it. Observe `send:finalized` for completion.

Use `ops.send.cancel(id)` for a prepared send and `ops.send.reclaim(id)` for an unclaimed pending
send. Reclaim can incur a fee or lose a race with the recipient; show its actual result. Keep
the operation ID so navigating away does not strand reserved or pending value.

See [Send Operations](https://cashubtc.github.io/coco/pages/send-operations) and
[Receive Operations](https://cashubtc.github.io/coco/pages/receive-operations) for state-specific
actions. Apply the skill's interruption rules to errors; cancellation is a user action on an
eligible state, not generic network-error cleanup.

## Receive Lightning: mint

```ts
const quote = await coco.quotes.mint.create({ mintUrl, amount: 100, method: 'bolt11' });
const pendingMint = await coco.ops.mint.prepare({ quote, amount: 100 });
const invoiceToDisplay = pendingMint.request;
```

Show the BOLT11 request and track `pendingMint.id`. Default background services observe payment
and claim the proofs. Report funds received when the operation is `finalized`, using
`mint-op:finalized` and a persisted-state read when mounting or resuming. A quote being paid does
not itself establish that local proofs were saved. Offer an explicit check through
`ops.mint.checkPayment(id)` when needed; keep background defaults for the ordinary flow.

Quote lookups and refresh use `{ mintUrl, quoteId }`; the operation ID is a separate identifier.
Mint Quote expiry is a deadline for initiating payment, not proof that already paid value is
unclaimable. Continue reconciling paid work through Coco.

## Pay Lightning: melt

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});
const prepared = await coco.ops.melt.prepare({ quote });
// Show prepared.amount, prepared.unit, prepared.fee_reserve, and prepared.swap_fee.
// After user confirmation:
const result = await coco.ops.melt.execute(prepared.id);
```

Execution may return `pending` or `finalized`. Subscribe before execution to
`melt-op:finalized` and `melt-op:rolled-back`, filtered by this operation ID; also handle an
immediate finalized return. Default background services settle pending melts. Use
`ops.melt.refresh(id)` for an explicit state check, not a new payment attempt. A finalized melt
can expose `effectiveFee` and `changeAmount`; render them when present.

Use `ops.melt.cancel(id)` if the user abandons a prepared payment. For pending melts, let Coco's
state-aware refresh/reclaim APIs establish whether funds can be released.

## Wallet Import and Restore

Reconstruct the Wallet Seed from the user's Wallet Recovery Material using the original
derivation. Open its dedicated database and Coco Session, then call
`coco.wallet.restore(mintUrl)` for each user-selected mint that may hold funds. Restore adds and
trusts that mint, so obtain the mint choice before invoking it.

Wallet Import establishes identity; Restore reconstructs proofs from deterministic secrets and
mint state. Startup Operation Recovery instead reconciles local in-flight operations. Keep these
as distinct UI actions. A seed backup alone does not identify every mint or reconstruct all local
history and non-deterministic/imported secrets; preserve the mint list and describe backup limits.

See [BIP39 and Restore](https://cashubtc.github.io/coco/pages/bip39).

## Additional requested features

- BOLT12 or onchain: read [Minting](https://cashubtc.github.io/coco/starting/minting) and
  [Melting](https://cashubtc.github.io/coco/starting/melting). Check mint-advertised payment method
  capabilities for the selected unit; onchain melt preparation needs an advertised fee option.
- Payment requests: read [Payment Requests](https://cashubtc.github.io/coco/starting/payment-requests)
  and use `coco.paymentRequests` for parsing, preparing, and executing them.
- Locked ecash: read [KeyRing](https://cashubtc.github.io/coco/pages/keyring) and the P2PK section of
  Send Operations before choosing a send target or managing spending keys.
