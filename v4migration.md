# cashu-ts v4 Migration Assessment

Target source:

- `@cashu/cashu-ts` release tag: https://github.com/cashubtc/cashu-ts/releases/tag/v4.1.0

Source reviewed:

- `cashu-ts` v4.1.0 release/tag docs and API surface
- https://cashu-ts.dev/
- Current `cashubtc/coco` checkout

## Short Answer

Upgrading Coco to `@cashu/cashu-ts` v4 is a real migration, not a dependency bump.

Estimated hassle:

- **7/10** if Coco embraces cashu-ts v4 `Amount` as the core amount model and migrates Coco's
  public/domain types to bigint-backed amount semantics.

The biggest risk is not wallet flow semantics. It is the amount model migration and the package
format boundary.

## Release Policy

This migration is a breaking release.

Reasons:

- Coco drops CommonJS support for v4-backed packages and becomes ESM-only where cashu-ts v4 is used.
- Public amount-bearing APIs move from `number` to `Amount` / `AmountLike`.
- Persisted bigint-backed amounts move to canonical decimal `TEXT`.

The implementation should include a major changeset and consumer migration notes. Those notes should
call out import/runtime format changes, amount type changes, JSON behavior, and storage migration
expectations for custom repository adapters.

## Main Blockers

### 1. cashu-ts v4 is ESM-only

Coco currently publishes CJS entry points for core and adapter packages. For example,
`packages/core/package.json` exposes `require: "./dist/index.cjs"`, and
`packages/core/tsdown.config.ts` builds `format: ["esm", "cjs"]`.

The current generated CJS output requires cashu-ts directly. With cashu-ts v4, that will fail
unless Coco drops CJS support for packages that import cashu-ts.

Decision: **drop CJS support** and make the v4-backed packages ESM-only.

Affected package surface:

- `packages/core`
- `packages/adapter-tests`
- `packages/sqlite3`
- `packages/sqlite-bun`
- `packages/indexeddb`
- `packages/expo-sqlite`

For each affected package:

- Remove `main: "dist/index.cjs"` from `package.json`.
- Keep the ESM entry point as `main` / `module` where the package keeps both fields, or simplify to
  the repo's chosen ESM-only package shape.
- Remove `exports["."].require`.
- Remove `.cjs` build outputs from `tsdown.config.ts`.
- Keep `types` and `exports["."].types` pointing at the generated declaration files.

`packages/react` is already ESM-only from its package manifest perspective, but it should still be
typechecked and built after the core package surface changes because it imports `@cashu/coco-core`.
`packages/docs` does not publish a CJS library surface, but docs examples and migration notes must
be updated for the v4 APIs.

### 2. `Amount` replaces plain `number` in key places

cashu-ts v4 changes many amount-bearing values from `number` to the bigint-backed `Amount` value
object.

Relevant Coco hotspots:

- `Proof.amount` arithmetic in `ProofService`, send handlers, melt handlers, tests, and adapter
  tests.
- `MintQuote.amount`, `MeltQuote.amount`, and `MeltQuote.fee_reserve`.
- `wallet.getFeesForProofs(...)` and `wallet.getFeesForKeyset(...)`.
- `PaymentRequest.amount`.
- `OutputData.blindedMessage.amount` and serialized output-data recovery paths.

Coco should adopt the upstream `Amount` model natively instead of flattening it to `number`.
That means:

- Domain and operation types should use `Amount` for monetary values.
- User/API inputs can accept `AmountLike` where ergonomic.
- Arithmetic should use class methods such as `.add(...)`, `.subtract(...)`, `.equals(...)`,
  `.lessThan(...)`, `.greaterThan(...)`, `.ceilPercent(...)`, `.floorPercent(...)`, and
  `.scaledBy(...)`.
- `.toNumber()` should be reserved for hard number-only boundaries such as legacy display APIs,
  tests that intentionally assert small values, or integrations that cannot accept bigint/string
  representations.

`Amount` is non-negative. Signed concepts must be modeled separately. Do not represent deltas,
debits, credits, net changes, or accounting movements with negative amounts. Use an explicit shape,
for example:

```ts
type SignedAmount = {
  direction: 'credit' | 'debit';
  amount: Amount;
};
```

### 3. `CoreProof extends Proof` pulls `Amount` into Coco's domain model

`packages/core/types.ts` currently defines `CoreProof extends Proof`.

In v4, that means `CoreProof.amount` becomes `Amount`. That is acceptable if Coco adopts
bigint-backed amount semantics, but it forces a deliberate storage and JSON migration.

Recommended approach:

- Keep `CoreProof.amount` as `Amount` in memory.
- Introduce repository serialization helpers that store bigint-backed amounts as canonical decimal
  `TEXT`.
- Rehydrate repository rows by converting `TEXT` back into `Amount` / bigint-backed values with
  `Amount.from(...)`.
- Update balance, history, operation, and event payload types to expose `Amount` or documented
  `AmountLike` inputs.

This makes the migration broader, but it aligns Coco with the upstream v4 safety model and avoids
silently reintroducing JavaScript number precision limits.

### 4. OutputData serialization needs rehydration

`packages/core/utils.ts` serializes `OutputData.blindedMessage.amount` as `number`.

In v4, that field is an `Amount`, so serialization and deserialization must be deliberate:

- Serialize as a decimal string, matching `Amount.toJSON()` semantics.
- Rehydrate with `Amount.from(...)` when constructing v4 `OutputData` or serialized blinded
  messages.

This matters for crash recovery because send/melt/receive recovery reconstructs proofs from stored
output data.

### 5. Removed or changed v3 APIs

Known current call sites that need attention:

- `wallet.createMeltQuote(...)` should become `wallet.createMeltQuoteBolt11(...)`.
- `WalletApi.encodeToken(token, { version?: 3 | 4 })` is no longer compatible with v4 because v3
  token encoding options were removed.
- `KeyChainCache` changed shape: v4 removes the cache-level `unit` field and uses explicit unit
  selection on restore.
- Direct `getDecodedToken(...)` use is still viable only when passing keyset IDs. Coco already does
  this in `TokenService`, but the preferred v4 pattern is `getTokenMetadata(...)` plus
  `wallet.decodeToken(...)` after loading the wallet.

## Recommended Migration Shape

Use a native `Amount` strategy. Coco should treat `Amount` as the domain representation for
non-negative monetary magnitudes and use `AmountLike` as the ergonomic input boundary.

1. Move v4-backed packages to ESM-only:
   - Remove CJS outputs from tsdown configs for packages that import cashu-ts.
   - Remove `require` export conditions and `.cjs` entry points from affected package manifests.
   - Document the runtime/package-format break in the migration notes and changesets.

2. Establish Coco's amount contract:
   - Re-export `Amount` and `AmountLike` from `@cashu/cashu-ts`.
   - Use `Amount` for persisted/domain values such as proofs, balances, operation amounts, quote
     amounts, fees, history amounts, and payment request amounts.
   - Use `AmountLike` for user-facing inputs where callers should be able to pass `number`,
     `bigint`, decimal `string`, or `Amount`.
   - Reserve `.toNumber()` for explicit legacy boundaries only.

3. Add amount helpers:
   - `toAmount(value: AmountLike): Amount`
   - `sumAmounts(values: Iterable<AmountLike>): Amount`
   - `serializeAmount(value: AmountLike): string`
   - `deserializeAmount(value: string | number | bigint | Amount): Amount`
   - Optional assertion helpers for non-zero, positive, or safe-number-only boundaries.

4. Migrate storage serialization:
   - Store proof, quote, operation, history, and serialized output-data amounts as canonical
     decimal `TEXT`.
   - Canonical decimal `TEXT` means a base-10 unsigned integer string: no fractional values, no
     scientific notation, no sign prefix, and no leading zeroes except the literal `"0"`.
   - Treat persisted amount `TEXT` as the only canonical storage representation. Do not add
     parallel integer or numeric metadata columns for now.
   - Convert `Amount` / bigint-backed values to decimal `TEXT` at the repository write boundary.
   - Convert decimal `TEXT` back to `Amount` / bigint-backed values at the repository read boundary
     with `Amount.from(...)`.
   - Add adapter migrations where existing integer columns need to preserve values while moving to
     canonical `TEXT` storage.
   - Keep backward-compatible readers for old numeric rows during migration.
   - New writes must always use canonical decimal `TEXT`.

5. Update wallet and mint call sites:
   - Quote amounts and fee reserves.
   - Proof sum arithmetic.
   - Wallet fee helpers.
   - Payment request amount handling.
   - OutputData and restore paths.
   - Replace numeric comparisons with `Amount` comparisons.
   - Replace numeric arithmetic with `Amount` methods.

6. Update public APIs and docs:
   - Return `Amount` for balances, prepared operations, quotes, history, and payment requests.
   - Accept `AmountLike` for init/prepare methods where callers supply amounts.
   - Document JSON behavior: `Amount` serializes as a decimal string and callers should rehydrate
     with `Amount.from(...)` when needed.

7. Remove v3 token encoding options from Coco's public API or mark them as unsupported under the
   v4-backed release.

8. Update `KeyChainCache` construction and wallet cache loading.

9. Validate in layers:
   - `bun run --filter='@cashu/coco-core' typecheck`
   - `bun run --filter='@cashu/coco-core' test:unit`
   - `bun run --filter='@cashu/coco-adapter-tests' build`
   - `bun run --filter='@cashu/coco-sqlite' test`
   - `bun run --filter='@cashu/coco-sqlite-bun' test`
   - `bun run --filter='@cashu/coco-indexeddb' test`
   - `bun --cwd packages/expo-sqlite test`
   - `bun run --filter='@cashu/coco-react' typecheck`
   - `bun run --filter='@cashu/coco-react' lint`
   - `bun run --filter='@cashu/coco-react' build`
   - `bun run docs:build`

10. Add migration acceptance tests:
    - Old numeric rows hydrate to `Amount`.
    - New decimal `TEXT` rows round-trip exactly.
    - Large u64-range values round-trip through every adapter without JavaScript number precision
      loss.
    - Fresh SQL schemas expose amount-bearing columns as `TEXT`.
    - Upgraded SQL schemas preserve existing numeric values while converting canonical amount
      columns to `TEXT`.
    - IndexedDB stores canonical decimal strings for amount-bearing row fields after the migration.
    - Balances, history entries, operations, quotes, payment requests, and events expose `Amount`
      in public types.
    - React balance aggregation uses `Amount.add(...)` rather than numeric `+`.

## API and Model Change Inventory

The following amount-bearing surfaces should be updated during the native `Amount` migration.

### Public API Inputs

These caller-supplied values should generally become `AmountLike` and normalize immediately inside
the implementation:

- `packages/core/api/SendOpsApi.ts:17` - `PrepareSendInput.amount`.
- `packages/core/api/MintOpsApi.ts:15` - `PrepareMintInputCommon.amount`.
- `packages/core/api/PaymentRequestsApi.ts:28` - `options.amount`.
- `packages/core/operations/melt/MeltMethodHandler.ts:25` - melt method payload
  `amountSats` fields. Keep the method-specific field names for compatibility with Lightning method
  terminology, but widen them to `AmountLike` and normalize at the boundary.
- `packages/core/operations/send/SendOperationService.ts:121` - `init(..., amount, ...)`.
- `packages/core/operations/send/SendOperationService.ts:317` - `send(..., amount)`.
- `packages/core/operations/mint/MintOperationService.ts:131` - mint intent input amount.
- `packages/core/operations/mint/MintOperationService.ts:178` - `prepareNewQuote(..., amount, ...)`.
- `packages/core/services/PaymentRequestService.ts:97` - payment request preparation
  `options.amount`.
- `packages/core/services/ProofService.ts:140` - output creation `{ keep, send }` amounts.
- `packages/core/services/ProofService.ts:594` - `selectProofsToSend(..., amount, ...)`.
- `packages/core/services/ProofService.ts:724` - `createBlankOutputs(amount, ...)`.

### Public API Outputs and Domain Types

These fields should expose `Amount` in memory and through public TypeScript types:

- `packages/core/types.ts:7` - `BalanceSnapshot.spendable`, `reserved`, and `total`.
- `packages/core/types.ts:23` - deprecated `BalanceBreakdown.ready`, `reserved`, and `total`.
- `packages/core/api/WalletBalancesApi.ts:11` - `byMint(): Promise<BalancesByMint>`.
- `packages/core/api/WalletBalancesApi.ts:15` - `total(): Promise<BalanceSnapshot>`.
- `packages/core/services/PaymentRequestService.ts:15` - `ResolvedPaymentRequest.amount`.
- `packages/core/models/MintQuote.ts:3` - `MintQuote` inherits v4 quote `Amount` fields.
- `packages/core/models/MeltQuote.ts:3` - `MeltQuote` inherits v4 quote `Amount` fields.

### Operation Models

These operation fields should be `Amount` because they represent persisted/domain state:

- `packages/core/operations/send/SendOperation.ts:45` - send `amount`.
- `packages/core/operations/send/SendOperation.ts:71` - send `fee`.
- `packages/core/operations/send/SendOperation.ts:74` - send `inputAmount`.
- `packages/core/operations/receive/ReceiveOperation.ts:36` - receive `amount`.
- `packages/core/operations/receive/ReceiveOperation.ts:56` - receive `fee`.
- `packages/core/operations/mint/MintOperation.ts:36` - mint intent `amount`.
- `packages/core/operations/melt/MeltOperation.ts:68` - melt `amount`.
- `packages/core/operations/melt/MeltOperation.ts:71` - melt `fee_reserve`.
- `packages/core/operations/melt/MeltOperation.ts:77` - melt `swap_fee`.
- `packages/core/operations/melt/MeltOperation.ts:80` - melt `inputAmount`.
- `packages/core/operations/melt/MeltOperation.ts:150` - melt `changeAmount`.
- `packages/core/operations/melt/MeltOperation.ts:158` - melt `effectiveFee`.
- `packages/core/operations/melt/MeltMethodHandler.ts:79` - `FinalizeResult.changeAmount` and
  `effectiveFee`.

Factory helpers should accept `AmountLike` where they receive caller or decoded input:

- `packages/core/operations/send/SendOperation.ts:288` - `createSendOperation(..., amount, ...)`.
- `packages/core/operations/receive/ReceiveOperation.ts:182` -
  `createReceiveOperation(..., amount, ...)`.
- `packages/core/operations/mint/MintOperation.ts:139` - `createMintOperation(..., intent, ...)`.

### History, Events, and Payment Requests

These surfaces carry operation or accounting amounts and should move with the domain types:

- `packages/core/models/History.ts:13` - `MintHistoryEntry.amount`.
- `packages/core/models/History.ts:21` - `MeltHistoryEntry.amount`.
- `packages/core/models/History.ts:34` - `SendHistoryEntry.amount`.
- `packages/core/models/History.ts:45` - `ReceiveHistoryEntry.amount`.
- `packages/core/events/types.ts:27` - `proofs:reserved.amount`.
- `packages/core/events/types.ts:29` - melt quote events carry v4 quote `Amount` fields.
- `packages/core/events/types.ts:33` - send events carry `SendOperation`.
- `packages/core/events/types.ts:43` - receive events carry `ReceiveOperation`.
- `packages/core/events/types.ts:61` - melt events carry `MeltOperation`.
- `packages/core/events/types.ts:65` - mint events carry `MintOperation`.
- `packages/core/services/PaymentRequestService.ts:23` - `PreparedPaymentRequest` embeds
  `ResolvedPaymentRequest`.
- `packages/core/services/PaymentRequestService.ts:28` - payment request execution results embed
  the resolved request and amount-bearing operation.

### Repository and Adapter Persistence

The repository interfaces mostly carry the domain models above, so the main work is adapter
serialization and migration:

- `packages/core/types.ts:34` - `CoreProof` inherits cashu-ts `Proof.amount`.
- `packages/core/repositories/index.ts:51` - `ProofRepository` persists and returns `CoreProof[]`.
- `packages/core/repositories/index.ts:108` - `MintQuoteRepository` persists `MintQuote`.
- `packages/core/repositories/index.ts:124` - `MeltQuoteRepository` persists `MeltQuote`.
- `packages/core/repositories/index.ts:131` - `HistoryRepository` persists `HistoryEntry`.
- `packages/core/repositories/index.ts:153` - `SendOperationRepository`.
- `packages/core/repositories/index.ts:176` - `MeltOperationRepository`.
- `packages/core/repositories/index.ts:211` - `MintOperationRepository`.
- `packages/core/repositories/index.ts:237` - `ReceiveOperationRepository`.
- `packages/sqlite3/src/schema.ts:107` - SQLite proof, quote, and history amount columns.
- `packages/sqlite3/src/schema.ts:264` - SQLite send operation amount columns.
- `packages/sqlite3/src/schema.ts:350` - SQLite melt operation amount columns.
- `packages/sqlite3/src/schema.ts:383` - SQLite receive operation amount columns.
- `packages/sqlite3/src/schema.ts:418` - SQLite melt settlement amount columns.
- `packages/sqlite3/src/schema.ts:475` - SQLite mint operation amount columns.
- `packages/sqlite-bun/src/schema.ts` - mirror the SQLite amount-column migration and repository
  serialization changes.
- `packages/expo-sqlite/src/schema.ts` - mirror the SQLite amount-column migration and repository
  serialization changes.
- `packages/indexeddb/src/lib/db.ts:134` - IndexedDB proof and quote rows.
- `packages/indexeddb/src/lib/db.ts:171` - IndexedDB send, receive, and melt rows.
- `packages/indexeddb/src/lib/db.ts:226` - IndexedDB melt settlement fields.
- `packages/indexeddb/src/lib/db.ts:250` - IndexedDB mint operation amount.
- `packages/adapter-tests/src/integration.ts` - shared adapter fixtures, balance assertions, and
  amount arithmetic.
- `packages/adapter-tests/src/migrations.ts` - shared migration assertions for old numeric rows and
  new canonical `TEXT` rows.

The same storage migration pattern should be mirrored in the SQLite-family adapters that share the
SQLite schema shape. Current adapter query patterns do not require database-side integer amount
operations: amounts are selected and persisted as values, while filtering, ordering, and indexes use
ids, state, mint URLs, quote IDs, operation IDs, and timestamps. The v4 migration should therefore
change amount columns and row properties to canonical decimal `TEXT` / strings without adding
separate numeric columns.

Implementation notes for SQLite-family migrations:

- Rebuild tables where SQLite cannot alter column types in place.
- Copy old numeric rows with `CAST(amount AS TEXT)`-style conversion for each amount-bearing column.
- Preserve all existing primary keys, unique indexes, partial indexes, state constraints, and
  operation linkage columns during table rebuilds.
- Keep migration readers tolerant of both old numeric and new text values until all supported
  upgrade paths have crossed the amount-storage migration.

Implementation notes for IndexedDB:

- Add a schema version that rewrites amount-bearing row fields to canonical decimal strings.
- Keep old numeric IndexedDB rows readable and hydrate them through the same deserialization helper.
- Do not add amount indexes; current query patterns do not need them.

### Helper Exports and React

Helper and UI-facing derived values need explicit `Amount` behavior:

- `packages/core/utils.ts:13` - `SerializedBlindedMessage.amount`.
- `packages/core/utils.ts:63` - `serializeOutput()` should serialize `Amount` as decimal text.
- `packages/core/utils.ts:78` - `deserializeOutput()` should rehydrate with `Amount.from(...)`.
- `packages/core/index.ts:7` - exported `CoreProof`, `BalanceSnapshot`, `BalanceBreakdown`, and
  related balance types.
- `packages/core/index.ts:17` - cashu-ts helper re-exports expose v4 token/proof amount shapes.
- `packages/react/src/lib/contexts/BalanceContext.ts:4` - React balance context carries
  `BalanceSnapshot`.
- `packages/react/src/lib/hooks/useBalances.ts:29` - empty balance values should use
  `Amount.zero()`.
- `packages/react/src/lib/hooks/useBalances.ts:40` - balance aggregation should use `Amount.add`.

Not every numeric field is an amount. `Keyset.feePpk`, counters, timestamps, expiries, derivation
indexes, limits, offsets, and page numbers should remain plain numbers.

## Practical Estimate

This is likely a multi-day migration:

- One focused pass for dependency/package-format changes and type fallout.
- One pass for adopting `Amount` across core proof, quote, operation, balance, history, and payment
  request types.
- One pass for adapter serialization/migrations and integration fixtures.

The migration should be done on its own branch with a clear compatibility note, because it likely
changes package runtime requirements and public amount semantics.

## Persistence Decision: TEXT Amount Storage

Coco will persist bigint-backed amounts as canonical decimal `TEXT` so every adapter can hydrate
exact u64 values into `Amount` without depending on JavaScript number precision.

Canonical format: persisted amount text is a base-10 unsigned integer string with no fractional
part, no exponent, no sign prefix, and no leading zeroes except `"0"`.

Boundary rule: repository adapters convert `Amount` / bigint-backed domain values to decimal `TEXT`
when writing, and convert decimal `TEXT` back to `Amount` / bigint-backed values when reading. The
database representation is text; arithmetic, comparison, and aggregation belong in the domain layer
after hydration.

Compatibility rule: old numeric persisted rows must remain readable and hydrate to `Amount`, but all
new writes after the migration must write canonical decimal `TEXT`.

No numeric metadata columns for now. The current adapters do not rely on database-level integer
amount operations, amount sorting, amount range filters, or amount indexes, so the initial v4
storage migration should be text-only.

If a future feature needs database-side numeric ordering or filtering by amount, add that as a
separate, evidence-backed adapter change while keeping decimal `TEXT` as the canonical source.

## Amount Export Decision

Coco should re-export the upstream cashu-ts `Amount` class and `AmountLike` type instead of wrapping
or subclassing them:

```ts
export { Amount, type AmountLike } from '@cashu/cashu-ts';
```

Rationale:

- cashu-ts wallet, proof, quote, and payment-request APIs already return upstream `Amount`.
- A Coco wrapper would create constant unwrap/rewrap friction at every cashu-ts boundary.
- A wrapper or subclass could become type-incompatible with upstream `Proof`, quote, and wallet
  APIs.
- Re-exporting preserves upstream arithmetic, comparison, and JSON behavior exactly.

Coco should still own small helper functions for repository and API ergonomics:

```ts
export function toAmount(value: AmountLike): Amount;
export function serializeAmount(value: AmountLike): string;
export function deserializeAmount(value: string | number | bigint | Amount): Amount;
export function sumAmounts(values: Iterable<AmountLike>): Amount;
```

Consumers should import `Amount` from Coco's public barrel when using Coco APIs, but the runtime
class remains the upstream cashu-ts implementation.
