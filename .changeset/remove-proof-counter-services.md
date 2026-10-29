---
'@cashu/coco-core': major
---

Remove `ProofService` and `CounterService` from core and the plugin API. Plugins get no direct proof
or counter authority (ADR-0014).

- Removed the `ProofService` and `CounterService` classes and their exports, including
  `selectProofsToSend`, `calculateSendAmountWithFees`, `unblindAndSaveChangeProofs`,
  `recoverProofsFromOutputData`, `createOutputsAndIncrementCounters`, `createBlankOutputs`,
  `checkInflightProofs`, the balance readers, and every proof write method.
- Removed the `proofService` and `counterService` plugin `ServiceMap` keys.
- Added the read-only `balances` plugin key. It is the same `WalletBalancesApi` as
  `manager.wallet.balances`.
- The `WalletApi` constructor no longer accepts a `ProofService` and requires `BalanceQueries`:
  `new WalletApi(mintService, walletService, walletRestoreService, receiveOperationService,
tokenService, balanceQueries, logger?)`.

Migrate value movement to the operation services (`sendOperationService`,
`receiveOperationService`, `mintOperationService`, `meltOperationService`) and balance reads to
`balances`. There is no replacement for counter access. `CounterRepository` and repository
adapters are unchanged; no persistence migration is needed.
