# Migrating from v1

This release is a v2 compatibility cut. It changes several user-facing
boundaries that v1 applications, React apps, plugins, and custom storage
adapters may depend on:

- The `@cashu/coco-core` package root is now the app-facing API. Adapter and
  plugin contracts moved to explicit subpaths.
- Amount values now follow `cashu-ts` v4. Public inputs accept `AmountLike`, but
  most amount-bearing records expose `Amount` objects instead of plain numbers.
- Units are first-class. Proofs, balances, operations, events, and persisted rows
  carry a normalized `unit`.
- History is now projected from operation repositories instead of being written
  as a separate activity table.
- Quote state is now durable, canonical state under `manager.quotes`, separate
  from mint and melt operation lifecycle state.
- Default `initializeCoco()` wiring starts watchers and processors that may
  settle pending mint and melt operations in the background.

Operations are now the canonical source of wallet activity. History reads are
derived from send, melt, mint, and receive operation repositories, with older
`coco_cashu_history` rows retained as read-only compatibility entries.

Quote rows are not value movements. Creating or refreshing a quote does not
create history by itself; history starts when an operation exists.

## Migration checklist

- Replace CommonJS `require(...)` usage with ESM imports or dynamic `import()`.
- Keep app-facing imports on `@cashu/coco-core`.
- Move adapter-facing imports to `@cashu/coco-core/adapter`.
- Move plugin-facing imports to `@cashu/coco-core/plugin`.
- Audit amount reads. Treat balances, proofs, quote amounts, operation amounts,
  history amounts, and amount-bearing event payloads as `Amount` values.
- Audit unit assumptions. Bare amount inputs still default to `sat`, but custom
  units must pass `{ amount, unit }` together and persisted proofs must keep
  their `unit`.
- Identify quotes by `{ mintUrl, quoteId }`, not by `quoteId` alone.
- Replace removed quote waiters and old quote events with canonical quote events
  plus operation events.
- Update React hook calls that used quote lookup helpers or import helpers.
- If you use a custom repository implementation, implement the current
  repository aggregate before opening existing wallet data with v2.
- If your app needs v1-style manual settlement, disable the default melt watcher
  and settlement processor in `initializeCoco()`. This stops ongoing background
  settlement, but startup recovery still runs before `initializeCoco()` returns.

## Package and import migration

All published packages are ESM packages. Projects that imported Coco with
CommonJS `require(...)` must move to ESM imports or dynamic `import()`.

Application code should import manager-facing APIs from the package root:

```ts
import { initializeCoco, Amount, type Manager } from '@cashu/coco-core';
```

The root no longer exports repository contracts, adapter serialization helpers,
concrete services, operation service classes, handler providers, transport
internals, plugin host internals, or individual memory repository classes as
app-facing API.

Storage adapters and adapter tests should import persistence contracts and
serialization helpers from the adapter subpath:

```ts
import { type Repositories, serializeAmount } from '@cashu/coco-core/adapter';
```

Plugins should import plugin lifecycle types and plugin-specific errors from the
plugin subpath:

```ts
import type { Plugin, PluginExtensions, ServiceKey } from '@cashu/coco-core/plugin';
```

`MemoryRepositories` remains available from `@cashu/coco-core` for in-memory app
setups and tests. Individual memory repository classes are internal.

## Amount and unit migration

v2 uses the `Amount` type from `cashu-ts` v4. Numeric inputs still work at public
API boundaries because Coco accepts `AmountLike`, but returned records should no
longer be treated as plain numbers.

```ts
const balances = await manager.wallet.balances.total();

// before: number arithmetic/formatting
// renderBalance(balances.total);

// after: use the Amount value intentionally
renderBalance(balances.total.toString());
```

This applies to balance snapshots, proofs, mint quotes, melt quotes, operation
records, history entries, and event payloads. Custom persistence code should
store amount values using the adapter helpers such as `serializeAmount()` and
`deserializeAmount()` from `@cashu/coco-core/adapter`; maintained adapters
migrate their stored amounts automatically.

Units are now part of the wallet model. Bare amount inputs keep the historical
default unit:

```ts
await manager.ops.send.prepare({ mintUrl, amount: 100 });
// Equivalent to { amount: 100, unit: 'sat' }
```

When an app supports another unit, pass the amount and unit together:

```ts
await manager.ops.send.prepare({
  mintUrl,
  amount: { amount: 5, unit: 'usd' },
});
```

Balance snapshots include `unit`. Use `wallet.balances.byMintAndUnit()` and
`wallet.balances.totalByUnit()` when a wallet may hold more than one unit.
`wallet.balances.byMint()` and `wallet.balances.total()` keep a single-unit view
and default to sats unless you pass `units`.

Custom proof stores must persist `CoreProof.unit` and honor `ProofUnitFilter`.
The `proofs:reserved` event now reports `amount` as `{ amount, unit }`.

## Canonical quote APIs

Use `manager.quotes` when you need to create, reload, list, or refresh quote
payment requests without treating that quote as a wallet activity yet:

- `manager.quotes.mint.create({ mintUrl, amount, unit?, method })`
- `manager.quotes.mint.get({ mintUrl, quoteId })`
- `manager.quotes.mint.listPending({ method? })`
- `manager.quotes.mint.refresh({ mintUrl, quoteId })`
- `manager.quotes.melt.create({ mintUrl, method, methodData, unit? })`
- `manager.quotes.melt.get({ mintUrl, quoteId })`
- `manager.quotes.melt.listPending({ method? })`
- `manager.quotes.melt.refresh({ mintUrl, quoteId })`

For BOLT11 quotes, the invoice is exposed as `quote.request`.

Store quote identity as `{ mintUrl, quoteId }`. `quoteId` is no longer a
sufficient lookup key on its own, and it should not be treated as an operation
id. Full canonical quote objects structurally satisfy the operation quote ref
types because they include `{ mintUrl, quoteId, method }`.

Within each quote kind, custom stores must enforce one quote per normalized
`{ mintUrl, quoteId }`. If old data contains the same quote id for multiple
methods at the same mint, v2 treats that as an identity conflict instead of
guessing which quote to load.

TypeScript supported-method generics were removed from the quote API facade and
input aliases. Use the concrete `QuoteApi`, `MintQuoteApi`, `MeltQuoteApi`,
`CreateMintQuoteInput`, and `CreateMeltQuoteInput` types directly instead of
passing method subset type parameters such as `QuoteApi<'bolt11'>` or
`CreateMintQuoteInput<'bolt11'>`.

## Mint quote migration

Mint operation prepare no longer creates a remote quote. Create the canonical
quote first, then prepare the operation from that quote with
`prepare({ quote, amount })`:

```ts
const quote = await manager.quotes.mint.create({
  mintUrl,
  amount: 100,
  method: 'bolt11',
});

showInvoice(quote.request);

const operation = await manager.ops.mint.prepare({
  quote,
  amount: 100,
});
```

`manager.ops.mint.importQuote(...)` was removed. Import existing mint quotes
through the quote API, then prepare an operation explicitly when you want history
and redemption tracking:

```ts
const quote = await manager.quotes.mint.import({
  mintUrl,
  method: 'bolt11',
  quote: quoteSnapshot,
});

const operation = await manager.ops.mint.prepare({
  quote,
  amount: quoteSnapshot.amount,
});
```

Importing a quote only updates canonical quote state. It can start quote
watching through `mint-quote:updated`, but it does not create a mint operation or
history entry. Mint operations no longer mirror quote remote state; listen for
`mint-quote:updated` or call `manager.quotes.mint.get(...)` when you need quote
payment state.

`manager.ops.mint.getByQuote(...)` was removed because a reusable quote can back
more than one local mint operation:

```ts
const operations = await manager.ops.mint.listByQuote({ mintUrl, quoteId });
```

Decide how your app wants to handle multiple tracked operations.

Mint operation prepare derives the quote method, unit, request details, and
method data from the canonical quote. Do not pass sibling `method`, `unit`, or
`methodData` fields to `manager.ops.mint.prepare(...)`.

## Quote waiter migration

The public subscription quote waiters were removed because they returned raw
transport notification payloads and their names implied stronger domain
guarantees than they provided.

Before:

```ts
await manager.subscription.awaitMintQuotePaid(mintUrl, quoteId);
await manager.subscription.awaitMeltQuotePaid(mintUrl, quoteId);
```

After, subscribe to canonical events for live quote state:

```ts
const offMint = manager.on('mint-quote:updated', ({ mintUrl, quoteId, quote }) => {
  if (mintUrl !== expectedMintUrl || quoteId !== expectedQuoteId) return;
  renderMintQuote(quote);
});

const offMelt = manager.on('melt-quote:updated', ({ mintUrl, quoteId, quote }) => {
  if (mintUrl !== expectedMintUrl || quoteId !== expectedQuoteId) return;
  renderMeltQuote(quote);
});
```

Use `manager.quotes.*.refresh({ mintUrl, quoteId })` when resuming or when your
app wants to explicitly check remote quote state. Use operation APIs and
operation events such as `mint-op:finalized`, `melt-op:finalized`, or
`melt-op:rolled-back` when the app needs to wait for value movement to reach a
terminal state.

## Melt quote migration

Melt quote creation moved out of `manager.ops.melt.prepare()`. Code that used to
pass the invoice directly to `prepare()` must now create the canonical quote
first:

```ts
const quote = await manager.quotes.melt.create({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

const prepared = await manager.ops.melt.prepare({
  quote,
});
```

`manager.ops.melt.prepare()` now reserves proofs and calculates fees from an
existing canonical melt quote. Use `manager.ops.melt.getByQuote({ mintUrl,
quoteId })` when resolving a melt operation by quote identity. Use
`manager.ops.melt.listByQuote({ mintUrl, quoteId })` when multiple tracked
operations are possible.

The legacy melt quote service surface was removed. Code that imported or
injected `MeltQuoteService`, legacy melt quote repositories, or plugin
`meltQuoteService` must move to `manager.quotes.melt` for quote state and
`manager.ops.melt` for operation state.

## Quote events

The old operation-shaped mint quote event was removed:

```ts
// before
manager.on('mint-op:quote-state-changed', ({ operationId, state }) => {
  console.log(operationId, state);
});

// after
manager.on('mint-quote:updated', ({ mintUrl, method, quoteId, quote }) => {
  console.log(mintUrl, method, quoteId, quote.state);
});
```

Use `mint-quote:updated` only for quote state. Operation consumers should follow
`mint-op:pending`, `mint-op:executing`, and `mint-op:finalized`.

Because quote-only updates are separate from operation updates, `history:updated`
is not emitted for bare quote creation or quote refresh. When a quote update
affects a pending operation, the operation lifecycle emits the corresponding
`mint-op:*` event.

The old melt quote events were also removed:

- `melt-quote:created`
- `melt-quote:state-changed`
- `melt-quote:paid`

Use `melt-quote:updated` for canonical melt quote state, and use
`melt-op:finalized` or `melt-op:rolled-back` when the app needs terminal value
movement.

The old `send:created` event was removed. Send listeners that need the token
created by execution should subscribe to `send:pending`:

```ts
manager.on('send:pending', ({ mintUrl, operationId, operation, token }) => {
  console.log(mintUrl, operationId, operation.state, token);
});
```

## Adapter and persistence migration

The bundled adapters migrate existing data automatically:

- canonical mint quote rows are backfilled from mint operations
- old mint quote rows remain readable through the legacy reconciliation path
- melt quote rows become method-aware canonical quote rows
- operation quote lookups become method-aware

The SQLite adapter packages now expose a narrower public surface for the major
release. Import `SqliteRepositories` from the runtime-specific package
(`@cashu/coco-sqlite`, `@cashu/coco-sqlite-bun`, or
`@cashu/coco-expo-sqlite`), pass an already-opened database instance, and call
`repositories.init()` before using the manager. Migration helpers, database
wrapper classes, and individual repository classes are no longer public adapter
exports.

For Expo, `ExpoSqliteRepositories` and `ExpoSqliteRepositoriesOptions` remain
available as soft-migration aliases for `SqliteRepositories` and
`SqliteRepositoriesOptions`.

Custom repository implementations must provide the current repository contract:

- `MintQuoteRepository` with `{ mintUrl, quoteId }` identity helpers and
  method-aware exact lookup
- `MeltQuoteRepository` with `{ mintUrl, quoteId }` identity helpers and
  method-aware exact lookup
- `LegacyMintQuoteRepository` for startup reconciliation of old mint quote rows
- method-aware `MintOperationRepository.getByQuoteId(...)`
- `ProofRepository` methods that accept `ProofUnitFilter`, plus stored
  `CoreProof.unit`
- `ReceiveOperationRepository.getByPaymentRequestAttemptId(...)`
- `PaymentRequestReceiveOperationRepository`
- `PaymentRequestReceiveAttemptRepository`
- `HistoryProjectionRepository` read methods only; history is projected from
  operation repositories instead of mutated through an activity table

Incoming payment-request receive state is now persisted under
`manager.paymentRequests.incoming`. If your app constructs APIs directly or
implements a custom repository aggregate, include the payment-request receive
operation and attempt repositories. Receive operations created from an incoming
payment-request payload also carry source metadata so history and recovery can
trace the payload that produced the receive.

## React hook migration

The React operation hooks mirror `manager.ops.*`, so quote-related hook helpers
changed with the core operation APIs.

- `useMintOperation().importQuote` was removed. Import quotes through
  `manager.quotes.mint.import(...)`, then call `useMintOperation().prepare(...)`
  when the UI is ready to track redemption as a mint operation.
- `useMintOperation().getByQuote` was removed. Use
  `useMintOperation().listByQuote({ mintUrl, quoteId })`.
- `useMintOperation().listByQuote(...)` now takes one object argument with
  `{ mintUrl, quoteId }`.
- `useMeltOperation().getByQuote(...)` and
  `useMeltOperation().listByQuote(...)` now take one object argument with
  `{ mintUrl, quoteId }`.

Hook `prepare(...)` methods also follow the core quote-first flow: create or
load the canonical quote first, then pass `quote` to the operation hook.

## Manager lifecycle migration

`initializeCoco()` now starts watchers and processors by default. In v2, pending
melt operations can be checked, finalized, rolled back, persisted, and emitted
from background settlement without your app manually enabling those services.

This affects apps that expected v1-style manual settlement only. To stop ongoing
background melt settlement after initialization, disable the melt watcher and
settlement processor:

```ts
const manager = await initializeCoco({
  repo,
  seedGetter,
  watchers: {
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    meltSettlementProcessor: { disabled: true },
  },
});
```

This config does not skip startup recovery. `initializeCoco()` still runs
`manager.ops.melt.recovery.run()` before it returns. Melt recovery leaves
`prepared` operations for the app to decide, but it checks `pending` operations
and recovers `executing` operations. Those checks can finalize or roll back old
melts from a previous session. The watcher and processor config only controls
ongoing background settlement after initialization.

When the default settlement services are enabled, register `melt-op:finalized`
and `melt-op:rolled-back` listeners before calling `manager.ops.melt.execute()`
if the UI needs to observe every terminal transition.

`manager.dispose()` is terminal. After disposing a manager, do not call
`resumeSubscriptions()`, enable watchers or processors, register plugins, or
reuse the instance for wallet work. Create a new manager instead.

## Operation-backed history

### History entry identity

Operation-backed history entries now use deterministic ids:

- `send:<operationId>`
- `melt:<operationId>`
- `mint:<operationId>`
- `receive:<operationId>`

Legacy rows from the old history table use `legacy:<oldHistoryId>`.

If your app stores history entry ids, treat ids from the previous history table
as legacy ids. New operation-backed entries should be linked by `operationId`.

### Entry source

Every history entry includes `source`:

- `source: 'operation'` for entries projected from operation repositories
- `source: 'legacy'` for read-only fallback entries from old history rows

Operation-backed entries always have `operationId`. Legacy entries may not.

### State values

Operation-backed history uses operation state names:

- Send rollback is now `rolled_back`, not `rolledBack`.
- Receive rollback is now `rolled_back`, not `rolledBack`.
- Mint history uses mint operation states such as `pending`, `executing`,
  `finalized`, and `failed`.
- Melt history uses melt operation states such as `prepared`, `pending`,
  `finalized`, and `rolled_back`.

Legacy entries preserve the old stored state strings, including protocol quote
states such as `UNPAID`, `PENDING`, `PAID`, and `ISSUED`.

### Ordering and freshness

History entries now expose both `createdAt` and `updatedAt`.

Pagination is ordered by `createdAt DESC, id DESC`. Use `updatedAt` for
replacement, freshness, and realtime reconciliation, not for primary ordering.

### Legacy fallback rows

The old `coco_cashu_history` table or store remains readable. New operation
events no longer write to it.

Legacy rows are hidden when an operation-backed entry represents the same
activity:

- rows with `operationId` are hidden behind the same `type + operationId`
- mint and melt rows without `operationId` are hidden behind the same
  `type + mintUrl + quoteId`

Remaining legacy rows are best-effort display data and should not be treated as
operation lifecycle state.

### Realtime updates

`history:updated` still exists, but it now carries the operation-backed
projection for the changed operation. Consumers can update optimistically from
the payload, but repository reads remain authoritative.

History ignores `receive-op:prepared`. Receive entries are projected only for
`finalized` and `rolled_back` states.
