---
'@cashu/coco-core': minor
---

Delegate Sweep exchanges to public Receive operations so they inherit transactional settlement,
ordinary Receive history, and restart recovery. Sweep only exchanges unspent inputs and reports
pending and uneconomic skips.

`wallet.sweep()` now returns `SweepReport`; partial failures reject with `SweepError.report`, which
preserves all keyset outcomes and available Receive operation IDs. Amounts stay precise and scoped
to each keyset's unit. Callers explicitly typing the old `Promise<void>` return must update that
annotation. The plugin-reachable `walletRestoreService.sweepKeyset()` now returns a keyset result;
internal service construction takes the public Receive methods in place of ProofService and
WalletService dependencies. No persisted format or Receive lifecycle API changes are introduced.
