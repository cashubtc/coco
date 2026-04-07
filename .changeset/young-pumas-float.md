---
'@cashu/coco-core': patch
'@cashu/coco-react': patch
---

Add structured wallet balance APIs across the core and React packages.

Core now exposes canonical balance snapshots with spendable, reserved, and
total amounts via `manager.wallet.balances.byMint()` and
`manager.wallet.balances.total()`, along with new query/types support such as
`BalanceQuery`, `BalanceSnapshot`, and `BalancesByMint`.

React now exports `useBalances()` for the same structured balance data. The
existing `useTrustedBalance()` and `useBalanceContext()` APIs now return
structured `balances` data instead of the previous flat numeric balance map.
