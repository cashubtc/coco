# Migrating from v1

This release changes two user-facing lifecycle boundaries:

- History is now projected from operation repositories instead of being written
  as a separate activity table.
- Quote state is now durable, canonical state under `manager.quotes`, separate
  from mint and melt operation lifecycle state.

Operations are now the canonical source of wallet activity. History reads are
derived from send, melt, mint, and receive operation repositories, with older
`coco_cashu_history` rows retained as read-only compatibility entries.

Quote rows are not value movements. Creating or refreshing a quote does not
create history by itself; history starts when an operation exists.

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
operation events such as `mint-op:finalized` or `melt-op:finalized` when the app
needs to wait for value movement to complete.

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
