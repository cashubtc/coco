---
status: accepted
---

# Reconcile standalone Mint Operations from exact issuance evidence

Standalone BOLT11, BOLT12, and on-chain Mint Operations share balance-based claimability and one
reconciliation algorithm. Quote Accounting authorizes new claims; complete evidence for the exact
persisted outputs settles an operation. BOLT11 invoice amounts remain payment metadata, so partial
accounting is valid while normal legacy claiming still requests the full paid invoice amount.

Persist the exact request, signature variants, accounting baseline, and receipts through a
Mint-owned transaction gateway. Ambiguous submissions retain their full reservations, including
legacy pending rows whose submission history is unknown. A zero balance, expiry, or empty Restore
cannot prove non-issuance. Without a verified mint duplicate-request concurrency contract, automatic
replay stays disabled; this trades recovery liveness for preserving uncertain Wallet commitments.

Issuance evidence is independent of spendability. Already-spent outputs can prove completion;
unknown and pending proof states remain durably held without increasing ready balance. Preserve
historical finalized/failed outcomes without pretending they satisfy the new receipt invariant.

This supersedes the standalone lifecycle approach in PR #480 and the original BOLT11 exclusion in
issue #469. It preserves ADR-0007 normalization ownership and ADR-0008 advisory expiry. Batch Mint's
explicit ADR-0010 exceptions are unchanged and must not inherit these rules silently. See the
[transaction contract](../../../../TRANSACTION_DESIGN.md) and
[implementation design](../../../../docs/design/mint-reconciliation.md).
