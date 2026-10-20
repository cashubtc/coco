---
status: accepted
---

# Delegate Sweep transfers to Receive

Sweep discovers proofs from a source Wallet Seed and delegates their exchange into the destination
Wallet through the public workflow methods of `ReceiveOperationService`. `WalletRestoreService`
receives a narrow selection of those methods directly, without depending on the application-facing
`ReceiveOpsApi`. Coordinator calls happen outside transactions; Receive owns the durable exchange
and Operation Recovery. Sweep does not introduce a separate durable exchange lifecycle or depend
on Receive's transaction internals.

This boundary lets Sweep adoption proceed independently of the Receive migration to
[coordinator-owned transactions](0011-compose-wallet-transactions-in-the-owning-coordinator.md).
Delegation inherits Receive's guarantees as implemented; it does not establish that the legacy
Receive implementation already satisfies the transaction design. The intended guarantee is automatic
Operation Recovery for an interrupted submitted exchange, including a mint success before local
proof persistence.

Sweep submits only proofs observed as `UNSPENT`. It skips proofs observed as `PENDING` and reports
those skips to the caller; their value may be swept later if it becomes available. `wallet.sweep()`
returns a structured result per keyset, including the pending proof count, amount, and unit. Amounts
in different units remain separate.

Swept value appears through ordinary Receive history and events. Sweep-specific origin metadata is
outside this change, preserving reuse through Receive's existing coordinator methods.

Keysets are processed independently. A failed keyset does not undo completed transfers or prevent
attempting the remaining keysets. Once keyset processing starts, Sweep resolves with the complete
per-keyset report even if every keyset fails or remains unresolved. Callers must inspect the report;
resolution alone does not imply a successful transfer. Invalid input or mint setup failures reject
before keyset processing. The plugin-facing `sweepKeyset()` likewise reports discovery and exchange
failures as results; invalid mint URLs or units still reject before discovery.
A rejected Receive call alone does not establish that its exchange failed: Sweep must
use the public operation state to distinguish a completed exchange from an unresolved outcome.

Receive owns recovery of its exchanges; Sweep does not automatically resume discovery or untouched
keysets after a restart. Prepared Receives follow Receive's existing resume and cancellation policy.
Sweep reports unresolved operation IDs rather than automatically creating replacement operations.
This change adds neither a durable Sweep parent nor a separate retry or deduplication lifecycle.

A keyset whose available value is no greater than its receive fee remains a successful skip.
The report distinguishes this reason from skipped pending proofs and preserves the unit of each
reported amount.
