# Migrating to cashu-ts v4

Coco packages that use `@cashu/cashu-ts` now target the v4 API surface. This is
a breaking package-format and amount-model change for consumers.

## Package format

The v4-backed Coco packages are ESM-only:

- `@cashu/coco-core`
- `@cashu/coco-adapter-tests`
- `@cashu/coco-indexeddb`
- `@cashu/coco-expo-sqlite`
- `@cashu/coco-sqlite`
- `@cashu/coco-sqlite-bun`

Use `import` syntax from an ESM-compatible runtime or bundler. CommonJS
`require()` entry points are no longer published for these packages.

## Amount values

Coco now exposes the upstream `Amount` value object for monetary values and
accepts `AmountLike` where callers supply an amount:

```ts
import { Amount, type AmountLike } from '@cashu/coco-core';

const prepared = await coco.ops.send.prepare({
  mintUrl,
  amount: Amount.from(100),
});

async function prepareSend(amount: AmountLike) {
  return coco.ops.send.prepare({ mintUrl, amount });
}
```

Balances, proofs, operation amounts, quote amounts, fees, history entries, and
payment requests return `Amount` instances. Use `Amount` methods for arithmetic
and comparisons:

```ts
const balance = await coco.wallet.balances.total();

if (balance.spendable.greaterThan(Amount.from(0))) {
  console.log(balance.spendable.toString());
}
```

Use `.toNumber()` only at number-only boundaries where the value is known to fit
JavaScript's safe integer range.

## JSON and storage

`Amount` serializes as a decimal string in JSON. Rehydrate persisted or received
JSON values with `Amount.from(...)` before using them as `Amount` instances.

Repository adapters store amount-bearing columns as canonical decimal text.
Built-in adapters include migrations that preserve old numeric rows and write
new rows in the decimal text format.

Custom adapters should follow the same boundary:

- write amount values with the canonical decimal string representation
- read old numeric or new string rows into `Amount`
- keep arithmetic and comparisons in the domain layer after hydration

## Token encoding

`coco.wallet.encodeToken(token)` now follows the v4 `cashu-ts` API. Explicit
token version selection is no longer supported.
