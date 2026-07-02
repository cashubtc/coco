# @cashu/coco-core

## 2.0.0-rc.0

### Major Changes

- 3ba8af3: Add canonical quote identity contracts and enforce `(mintUrl, quoteId)` uniqueness for stored mint and melt quotes.
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

- e6c780a: Remove the legacy `MeltQuoteService`, `MeltQuoteRepository`, and `melt-quote:*`
  event API surface. Melts are now exposed through `manager.ops.melt`; existing
  legacy melt quote storage is preserved for data compatibility.
- f9db334: Add first-class custom Cashu unit support across core APIs, React balance hooks,
  operation recovery, and storage adapters.

  Bare amount inputs continue to default to sats, while object-form amount inputs
  carry an explicit unit. Proofs, balances, quotes, operations, history, tokens,
  restore/sweep flows, and adapter persistence now preserve normalized unit
  metadata, with migrations and contract tests covering legacy sat fallback and
  custom-unit rows.

- 71993c2: Refactor melt operation prepare to accept `{ quote }` for BOLT quotes and `{ quote, feeIndex }` for onchain quotes, deriving method data from stored canonical melt quote state.
- 167dec6: Make canonical quote get and refresh APIs resolve mint and melt quotes by `{ mintUrl, quoteId }`.
- 5e78860: Refactor mint operation prepare to accept `{ quote, amount }`, deriving method and unit data from the stored canonical mint quote.
- 6b8a896: Move mint quote import to `manager.quotes.mint.import(...)` and remove
  `manager.ops.mint.importQuote(...)`.

  Mint quote import now only updates canonical quote state and emits
  `mint-quote:updated` when a quote is created/imported or remote settlement state
  changes. Mint operations no longer mirror mutable quote remote state; callers
  should read quote state from `manager.quotes.mint.get(...)` or quote events and
  call `manager.ops.mint.prepare(...)` when they want an operation/history entry.

- 737b993: Narrow the root public entry point to app-facing wallet APIs, domain types, amount helpers,
  logging, events, and `MemoryRepositories`.

  Concrete services, operation service classes, repository contracts, individual memory
  repositories, infra transports, handler providers, plugin internals, and adapter
  serialization helpers are no longer exported from the package root. Storage adapter
  authors should import persistence contracts from `@cashu/coco-core/adapter`, and plugin
  authors should import extension contracts from `@cashu/coco-core/plugin`.

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

- 16fc82c: Update quote-backed operation query APIs to use `QuoteIdentity` object inputs, remove
  `MintOpsApi.getByQuote`, and resolve melt operation lookup through canonical quote identity.
- c8cee3c: Remove the undocumented `send:created` event from the public `CoreEvents` type. Consumers should use
  `send:pending`, which is the emitted token-created send lifecycle event.
- 0aa9a9f: Remove the public `SubscriptionApi` quote waiters. Use canonical quote events through
  `manager.on('mint-quote:updated', ...)` or `manager.on('melt-quote:updated', ...)`, explicit quote
  refreshes, and operation APIs for mint or melt completion.

### Minor Changes

- b2ffef1: Add BOLT12 mint and melt operation support, including duplicate quote-id safe persistence.
- 9275ab7: Expose mint and melt Payment Method Capability checks and listings on the mint API.
- fe8ef00: Allow attaching an optional memo when executing a send. `SendOpsApi.execute`
  now accepts `ExecuteSendOptions` with a `memo`, which is persisted on the
  executed send token.

### Patch Changes

- 1dfdebf: Fix reusable onchain mint quote redemption against NUT-30-capable mints.

  Onchain mint capability checks now use the NUT-04 method metadata advertised by
  current `mintd` releases, while legacy sat fallback remains limited to BOLT11.
  NUT-20 mint quote keys now persist public keys that match the stored secp256k1
  private key so `mintProofsOnchain` can sign funded quote redemptions reliably.

- 2601aee: Remove outdated prerelease warning text from the published package READMEs.
- 0e25ddc: Make `Manager.dispose()` stop manager-owned watchers, processors, subscriptions, and plugin
  resources, and let the React provider rely on core disposal directly.
- a8e029e: Guard send and melt fee calculations before subtracting `Amount` values.
- 0a2a8ce: Convert amountless BOLT11 melt amounts from sats to millisats before requesting cashu-ts quotes.
- 203ebf4: Start melt quote watching and melt settlement processing from the manager lifecycle by default,
  including pause, resume, disposal, and startup scans for pending melt quote and operation state.
- 34c16d3: Record pending melt quote observations before settling local melt operations, and use cached PAID
  observations during recovery only when serialized settlement change and method-specific settlement
  metadata are available.
- eefce1c: Persist meaningful melt quote observations and emit `melt-quote:updated` after canonical quote
  state changes.
- ab0fd42: Improve melt quote watcher subscription lifecycle by coalescing overlapping watch starts, normalizing full subscription payload amounts, cleaning up pending starts during shutdown, and clearing expired canonical interest while preserving operation-owned watches.
- e45cef2: Add a melt settlement processor that tracks exact pending melt operation interest, reacts to
  canonical melt quote updates, and advances interested operations through the existing melt saga
  without introducing a retry queue.
- d76264c: Add quote-first NUT-30 onchain melt operations.

  Core now supports onchain melt quotes, fee option selection on melt operations,
  onchain melt execution, and onchain melt quote polling. Adapter repositories now
  persist onchain melt quote fee options and outpoints with migrations for existing
  melt quote rows.

- ab8be2d: Watch reusable onchain mint quotes through the mint operation watcher.

  Onchain mint quote subscriptions now use polling as a concrete fallback, keep logical watches alive
  when WebSocket subscriptions are rejected, persist complete counter updates, and keep reusable quote
  watches running after individual claims finalize.

- 703a1b4: Export documented core event types and event bus APIs from the package root.
- 9342e56: Wrap malformed token proof amounts in `TokenValidationError` during token validation.
- 06deb29: Resolve receive recovery operations when spent inputs have no recoverable outputs.
- 9dd896d: Unblind restored signatures during proof recovery and reject restored proofs from mismatched keyset units.
- 9dc7be3: Claim reusable onchain mint quotes from the mint operation processor.

  When automatic mint quote claiming is enabled, claim processing now drains remaining claimable
  onchain quote balance by creating one pending mint operation and executing it under the quote lock.
  The processor claims pending reusable quotes on startup, reacts to canonical `mint-quote:updated`
  events asynchronously by full quote identity, and exposes an opt-out through
  `autoClaimMintQuotes`.

- d25551a: Avoid duplicate send finalization checks for proof state subscription notifications and batched
  spent-proof events from the same operation.
- fe4b820: Watch canonical BOLT11 mint quotes without requiring local mint operations.

  Mint quote creation now emits the canonical `mint-quote:updated` event after persistence, and the
  mint operation watcher subscribes to pending BOLT11 quote records directly on startup or when a
  canonical quote update appears. Remote quote notifications update the canonical quote row first, so
  pending operations continue to advance from quote-level events instead of watcher-owned operation
  state.

- ad67dbe: Add `@cashu/coco-core/adapter` as the stable import path for storage adapter contracts.
- 616f7f9: Add a stable `@cashu/coco-core/plugin` entry point for plugin author types.
- c489ac4: Reject duplicate melt operations for the same mint and quote across repository adapters.
- 807ae19: Avoid duplicate proof state entries in polling fallback `/checkstate` requests.

## 1.0.0

### Patch Changes

- 7f9cd39: Track receive history entries through prepared, finalized, and rolled-back
  operation states, and persist the correct receive unit across storage adapters.

  Core now emits explicit receive operation lifecycle events and updates history
  entries incrementally instead of only recording receives once a token has been
  created. The persistent adapters now support receive history lookups and
  updates, and receive operations persist their unit so non-sat history entries
  stay correct through recovery and restart flows.

- dabef01: Expose operation ids on history entries so consumers can act on the underlying
  operation directly.

  History entries now persist their linked `operationId` where available, and the
  core history API adds `getOperationIdForHistoryEntry()` for callers that only
  have a history entry id. This makes flows like reclaiming a send from a history
  item straightforward with the existing `manager.ops.*` APIs.

- 1daa3ce: Make React operation hooks reactive to manager events and simplify their binding
  lifecycle, while only persisting receive history once a receive is finalized.

  React operation hooks now stay bound to one operation for the lifetime of the
  hook instance, hydrate an initial `operationId` on mount, and update
  `currentOperation` from background operation events instead of requiring manual
  `load()` rebinding. The public `load()` method has been removed; if a mounted
  component needs to switch to a different operation, remount the hook or
  component with a new React `key`. This also guards against stale hydration
  results overwriting newer event-driven operation state.

  Core now records receive history only once a receive is finalized, instead of
  creating receive history entries during the prepared state. The legacy
  `receive:created` core event has also been removed.

- dad73ba: Prevent plugins from initializing twice through `initializeCoco()`, and make
  plugin lifecycle hooks idempotent across repeated or concurrent init and ready
  calls. Registering the same plugin instance more than once now throws instead
  of creating an unbalanced dispose lifecycle.
- 3e6b339: Recover executing melt operations from `manager.ops.melt.refresh()` so long-running
  clients can resolve stuck melts without waiting for a startup recovery sweep.
- 660cb8e: Remove the legacy scalar and breakdown balance helpers from `WalletApi`.

  `wallet.balances.byMint()` and `wallet.balances.total()` are now the only
  balance surface on `WalletApi`. The following methods have been removed:
  `getBalance`, `getBalances`, `getTrustedBalances`, `getSpendableBalance`,
  `getSpendableBalances`, `getTrustedSpendableBalances`, `getBalanceBreakdown`,
  `getBalancesBreakdown`, `getTrustedBalancesBreakdown`, `getBalancesByMint`,
  and `getBalanceTotal`. Migrate to `wallet.balances.byMint(scope?)` and
  `wallet.balances.total(scope?)`, which return structured `spendable`,
  `reserved`, and `total` values and accept an optional `{ mintUrls, trustedOnly }`
  scope.

- 505e1af: Preserve melt history entry units and amounts as quotes move through prepared,
  pending, finalized, and rolled-back operation states.

  This keeps `manager.history.*` melt entries aligned with the underlying melt
  operation data instead of falling back to incorrect defaults during history
  updates.

- a57cb82: Add structured wallet balance APIs across the core and React packages.

  Core now exposes canonical balance snapshots with spendable, reserved, and
  total amounts via `manager.wallet.balances.byMint()` and
  `manager.wallet.balances.total()`, along with new query/types support such as
  `BalanceQuery`, `BalanceSnapshot`, and `BalancesByMint`.

  React now exports `useBalances()` for the same structured balance data. The
  existing `useTrustedBalance()` and `useBalanceContext()` APIs now return
  structured `balances` data instead of the previous flat numeric balance map.

## 1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- 7f9cd39: Track receive history entries through prepared, finalized, and rolled-back
  operation states, and persist the correct receive unit across storage adapters.

  Core now emits explicit receive operation lifecycle events and updates history
  entries incrementally instead of only recording receives once a token has been
  created. The persistent adapters now support receive history lookups and
  updates, and receive operations persist their unit so non-sat history entries
  stay correct through recovery and restart flows.

- 1daa3ce: Make React operation hooks reactive to manager events and simplify their binding
  lifecycle, while only persisting receive history once a receive is finalized.

  React operation hooks now stay bound to one operation for the lifetime of the
  hook instance, hydrate an initial `operationId` on mount, and update
  `currentOperation` from background operation events instead of requiring manual
  `load()` rebinding. The public `load()` method has been removed; if a mounted
  component needs to switch to a different operation, remount the hook or
  component with a new React `key`. This also guards against stale hydration
  results overwriting newer event-driven operation state.

  Core now records receive history only once a receive is finalized, instead of
  creating receive history entries during the prepared state. The legacy
  `receive:created` core event has also been removed.

- 660cb8e: Remove the legacy scalar and breakdown balance helpers from `WalletApi`.

  `wallet.balances.byMint()` and `wallet.balances.total()` are now the only
  balance surface on `WalletApi`. The following methods have been removed:
  `getBalance`, `getBalances`, `getTrustedBalances`, `getSpendableBalance`,
  `getSpendableBalances`, `getTrustedSpendableBalances`, `getBalanceBreakdown`,
  `getBalancesBreakdown`, `getTrustedBalancesBreakdown`, `getBalancesByMint`,
  and `getBalanceTotal`. Migrate to `wallet.balances.byMint(scope?)` and
  `wallet.balances.total(scope?)`, which return structured `spendable`,
  `reserved`, and `total` values and accept an optional `{ mintUrls, trustedOnly }`
  scope.

## 1.0.0-rc.3

### Patch Changes

- dabef01: Expose operation ids on history entries so consumers can act on the underlying
  operation directly.

  History entries now persist their linked `operationId` where available, and the
  core history API adds `getOperationIdForHistoryEntry()` for callers that only
  have a history entry id. This makes flows like reclaiming a send from a history
  item straightforward with the existing `manager.ops.*` APIs.

- 505e1af: Preserve melt history entry units and amounts as quotes move through prepared,
  pending, finalized, and rolled-back operation states.

  This keeps `manager.history.*` melt entries aligned with the underlying melt
  operation data instead of falling back to incorrect defaults during history
  updates.

## 1.0.0-rc.1

### Patch Changes

- a57cb82: Add structured wallet balance APIs across the core and React packages.

  Core now exposes canonical balance snapshots with spendable, reserved, and
  total amounts via `manager.wallet.balances.byMint()` and
  `manager.wallet.balances.total()`, along with new query/types support such as
  `BalanceQuery`, `BalanceSnapshot`, and `BalancesByMint`.

  React now exports `useBalances()` for the same structured balance data. The
  existing `useTrustedBalance()` and `useBalanceContext()` APIs now return
  structured `balances` data instead of the previous flat numeric balance map.

## 1.0.0-rc.0

- Initial RC release under the `@cashu` namespace.
- Legacy changelog: `../../history/changelogs/legacy/core.md`
