# @cashu/coco-core

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
