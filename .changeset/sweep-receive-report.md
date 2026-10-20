---
'@cashu/coco-core': major
---

Delegate Sweep exchanges to public Receive operations so they inherit transactional settlement,
ordinary Receive history, and restart recovery. Sweep only exchanges unspent inputs and reports
pending and uneconomic skips.

Breaking change: `wallet.sweep()` now resolves with `SweepReport` after keyset processing, even if
every keyset fails or remains unresolved. Callers must inspect each result's `status`; catching a
rejection no longer detects keyset failures. Input validation and mint setup failures still reject.
The report preserves all keyset outcomes and available Receive operation IDs. Amounts stay precise
and scoped to each keyset's unit. Explicit `Promise<void>` annotations must change to `Promise<SweepReport>`.

The plugin-reachable `walletRestoreService.sweepKeyset()` also resolves with a result for discovery
and exchange failures. Plugins must check for `failed` and `unresolved` statuses instead of relying
on exceptions; invalid mint URLs or units still reject before discovery. Internal service construction
takes ReceiveOperationService's public workflow methods in place of ProofService and WalletService
dependencies. No persisted format or Receive lifecycle API changes are introduced.
