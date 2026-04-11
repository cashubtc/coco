---
'@cashu/coco-core': patch
---

Remove the legacy scalar and breakdown balance helpers from `WalletApi`.

`wallet.balances.byMint()` and `wallet.balances.total()` are now the only
balance surface on `WalletApi`. The following methods have been removed:
`getBalance`, `getBalances`, `getTrustedBalances`, `getSpendableBalance`,
`getSpendableBalances`, `getTrustedSpendableBalances`, `getBalanceBreakdown`,
`getBalancesBreakdown`, `getTrustedBalancesBreakdown`, `getBalancesByMint`,
and `getBalanceTotal`. Migrate to `wallet.balances.byMint(scope?)` and
`wallet.balances.total(scope?)`, which return structured `spendable`,
`reserved`, and `total` values and accept an optional `{ mintUrls, trustedOnly }`
scope.
