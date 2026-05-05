# @cashu/coco-core

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
