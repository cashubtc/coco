# @cashu/coco-adapter-tests

## 2.0.0-rc.0

### Major Changes

- b910b5f: Migrate Coco to `@cashu/cashu-ts` v4 and native `Amount` semantics.

  Public APIs now accept `AmountLike` inputs where callers provide monetary values
  and return upstream `Amount` instances for balances, operation amounts, fees,
  history entries, and proofs. Persistent adapters store amount columns as
  canonical decimal strings and include migrations that preserve old numeric rows.
  Operation method metadata serializes BigInt values as decimal strings so
  AmountLike method fields remain persistable across adapters, while known amount
  metadata is rehydrated as upstream `Amount` values on operation reads.

  Packages that depend on `cashu-ts` are now ESM-only. CommonJS export entries and
  CJS build outputs were removed, and token encoding now follows the v4 cashu-ts
  API without explicit token-version selection.

- f9db334: Add first-class custom Cashu unit support across core APIs, React balance hooks,
  operation recovery, and storage adapters.

  Bare amount inputs continue to default to sats, while object-form amount inputs
  carry an explicit unit. Proofs, balances, quotes, operations, history, tokens,
  restore/sweep flows, and adapter persistence now preserve normalized unit
  metadata, with migrations and contract tests covering legacy sat fallback and
  custom-unit rows.

- a7c49ff: Add incoming payment-request receive operations.

  Core now exposes a payment-request receive saga that creates encoded requests,
  claims incoming payloads into normal receive operations, deduplicates payloads,
  records receive metadata for history, and reconciles pending child receive
  operations during recovery.
  Transport plugins can now register receive handlers for external transports such
  as Nostr, and outgoing payment-request parsing exposes Nostr transport
  descriptors for plugin delivery.
  Incoming request creation stores active requests immediately; callers can
  cancel requests to stop accepting future payloads while keeping request history.
  Stored pre-child crash attempts are resumed during recovery; incomplete attempts
  without a durable payload are rejected so they do not pin future deliveries.

  Adapters now persist payment-request receive operations and attempts, and receive
  operations store optional source metadata for request-linked receives.

- 00ed073: Project history entries from operation repositories instead of maintaining a
  mutable history table.

  History entries now use deterministic `type:operationId` ids for operation
  rows, expose `source`, `updatedAt`, and `operationId` on operation-backed
  entries, and retain legacy table rows behind `legacy:*` ids for migration
  compatibility. The old history repository mutation contract has been removed;
  persistent adapters now read history by merging operation rows with legacy rows
  and de-duplicating legacy records that map to an operation.

- c0e8d4f: Add canonical method-aware mint quote records and make BOLT11 mint preparation
  quote-first.

  Core now exposes canonical quote resurfacing through `manager.quotes.mint` and
  `manager.quotes.melt`. Mint and melt quotes are created before
  `manager.ops.mint.prepare()` and `manager.ops.melt.prepare()`, keeping bare
  quote creation out of history. The quote API facade and input aliases use the
  concrete built-in method surface instead of supported-method subset generics.
  Mint quote records are keyed by normalized `(mintUrl, method, quoteId)`, and
  mint operation quote lookups now return all sibling operations for the full
  quote identity.

  Quote observers now receive the persisted canonical mint quote snapshot through
  the quote-level `mint-quote:updated` event, replacing the operation-shaped
  `mint-op:quote-state-changed` event. Mint operation progress remains exposed
  through `mint-op:*` lifecycle events.

  Method handler quote refresh hooks are now named `fetchRemoteQuote`, with
  matching `FetchRemote*QuoteContext` types, so handlers own remote protocol fetches
  while quote lifecycle services own canonical quote persistence and refresh
  events.

  Persistent adapters now store canonical mint and melt quotes, migrate existing
  BOLT11 operation quote snapshots into quote rows, and expose contract coverage
  for quote records and sibling operation lookup.

  Mint quote records now store method-scoped `quoteData` so BOLT11 fixed amounts
  and NUT-30 onchain balance snapshots can share the same canonical quote
  repository without requiring universal top-level quote `amount` or `state`
  fields.

  Keyring persistence now tracks key purpose metadata so NUT-20 mint quote keys
  can use a separate deterministic derivation branch and stay hidden from
  user-facing P2PK key management APIs.

  NUT-30 onchain mint quote creation now derives a fresh NUT-20 key, submits the
  public key in the onchain quote request, and persists the reusable address quote
  with `amount_paid`/`amount_issued` balance metadata.

  Onchain mint operation preparation now accepts an explicit withdrawal amount for
  pre-created reusable quotes, verifies the quote signing key before operation
  persistence, and creates operation-scoped deterministic outputs without requiring
  available remote balance during prepare.

  Onchain mint finalization now gates reusable quote execution on available remote
  balance minus locally executing siblings, keeps underfunded operations pending,
  signs mint requests with the persisted NUT-20 quote key, and refreshes the
  canonical quote before finalizing redeemed operations.

### Patch Changes

- b2ffef1: Add BOLT12 mint and melt operation support, including duplicate quote-id safe persistence.
- 3ba8af3: Add canonical quote identity contracts and enforce `(mintUrl, quoteId)` uniqueness for stored mint and melt quotes.
- 2601aee: Remove outdated prerelease warning text from the published package READMEs.
- 71993c2: Refactor melt operation prepare to accept `{ quote }` for BOLT quotes and `{ quote, feeIndex }` for onchain quotes, deriving method data from stored canonical melt quote state.
- 167dec6: Make canonical quote get and refresh APIs resolve mint and melt quotes by `{ mintUrl, quoteId }`.
- 5e78860: Refactor mint operation prepare to accept `{ quote, amount }`, deriving method and unit data from the stored canonical mint quote.
- d76264c: Add quote-first NUT-30 onchain melt operations.

  Core now supports onchain melt quotes, fee option selection on melt operations,
  onchain melt execution, and onchain melt quote polling. Adapter repositories now
  persist onchain melt quote fee options and outpoints with migrations for existing
  melt quote rows.

- 0ff89d6: Assert that mint operation repository contracts return only pending and executing work from
  `getPending()`.
- c489ac4: Reject duplicate melt operations for the same mint and quote across repository adapters.
- Updated dependencies [b2ffef1]
- Updated dependencies [1dfdebf]
- Updated dependencies [3ba8af3]
- Updated dependencies [2601aee]
- Updated dependencies [0e25ddc]
- Updated dependencies [b910b5f]
- Updated dependencies [a8e029e]
- Updated dependencies [e6c780a]
- Updated dependencies [f9db334]
- Updated dependencies [0a2a8ce]
- Updated dependencies [203ebf4]
- Updated dependencies [34c16d3]
- Updated dependencies [71993c2]
- Updated dependencies [eefce1c]
- Updated dependencies [ab0fd42]
- Updated dependencies [e45cef2]
- Updated dependencies [167dec6]
- Updated dependencies [5e78860]
- Updated dependencies [6b8a896]
- Updated dependencies [737b993]
- Updated dependencies [d76264c]
- Updated dependencies [ab8be2d]
- Updated dependencies [9275ab7]
- Updated dependencies [a7c49ff]
- Updated dependencies [fe8ef00]
- Updated dependencies [00ed073]
- Updated dependencies [703a1b4]
- Updated dependencies [9342e56]
- Updated dependencies [c0e8d4f]
- Updated dependencies [16fc82c]
- Updated dependencies [06deb29]
- Updated dependencies [c8cee3c]
- Updated dependencies [0aa9a9f]
- Updated dependencies [9dd896d]
- Updated dependencies [9dc7be3]
- Updated dependencies [d25551a]
- Updated dependencies [fe4b820]
- Updated dependencies [ad67dbe]
- Updated dependencies [616f7f9]
- Updated dependencies [c489ac4]
- Updated dependencies [807ae19]
  - @cashu/coco-core@2.0.0-rc.0

## 1.0.0

### Patch Changes

- fe1cabb: Serialize root repository operations while SQLite adapter transactions are active.
- Updated dependencies [7f9cd39]
- Updated dependencies [dabef01]
- Updated dependencies [1daa3ce]
- Updated dependencies [dad73ba]
- Updated dependencies [3e6b339]
- Updated dependencies [660cb8e]
- Updated dependencies [505e1af]
- Updated dependencies [a57cb82]
  - @cashu/coco-core@1.0.0

## 1.0.0-rc.5

### Patch Changes

- @cashu/coco-core@1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- Updated dependencies [7f9cd39]
- Updated dependencies [1daa3ce]
- Updated dependencies [660cb8e]
  - @cashu/coco-core@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [dabef01]
- Updated dependencies [505e1af]
  - @cashu/coco-core@1.0.0-rc.3

## 1.0.0-rc.1

### Patch Changes

- Updated dependencies [a57cb82]
  - @cashu/coco-core@1.0.0-rc.1

## 1.0.0-rc.0

- Initial RC release under the `@cashu` namespace.
- Legacy changelog: `../../history/changelogs/legacy/adapter-tests.md`
