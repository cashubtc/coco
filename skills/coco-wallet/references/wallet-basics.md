# Wallet basics

Read before implementing wallet features. Examples assume an initialized `coco`, a chosen
`mintUrl`, and validated inputs. The app supplies review and confirmation between API calls.

## Mint trust

Use `coco.mint.addMint(mintUrl)` to retain a Known Mint and inspect its information. After the
user approves it, call `coco.mint.trustMint(mintUrl)`. An explicitly chosen and approved mint can
be added with `{ trusted: true }`. Discover the selection with `getAllTrustedMints()`.

Trust is an explicit user decision before wallet operations. A mint URL supplied by a token, QR
code, or payment request is not approval to trust it.

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
if a displayed balance becomes stale. Refresh balance/history views from Coco events.

For multiple units, read [Multi-Unit Support](https://cashubtc.github.io/coco/pages/multi-unit-support).
Use `byMintAndUnit()` / `totalByUnit()` and show totals separately by unit. The default `byMint()`
and `total()` views are sat-scoped.
