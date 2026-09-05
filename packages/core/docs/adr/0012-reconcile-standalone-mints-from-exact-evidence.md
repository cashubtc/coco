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
explicit ADR-0010 exceptions are unchanged and must not inherit these rules silently. Local mutations
follow [ADR-0011](0011-use-domain-transaction-gateways.md).

## Consequences

Persist an issuance baseline alongside finalized local amounts so stale remote accounting cannot
reopen already claimed value: observing 100 paid / 40 issued, then issuing 60 locally, establishes a
completed floor of 100. Advance the baseline only when no unresolved sibling could already be
included in the remote issued total. Otherwise retain the prior baseline and the full unresolved
reservations; aggregate totals cannot attribute external-wallet issuance to local outputs.

Authorization and settlement each commit their operation, reservation/evidence, and affected Wallet
records atomically. Only the caller that commits an authorization may submit it; a competing or
restarted coordinator reconciles evidence. Negative conclusions require the matching authorization
revision, while valid late evidence can still settle the exact outputs. A crash between authorization
and transmission can therefore remain unresolved indefinitely under the no-replay policy.

Durable recovery data changes the adapter contract. Upgrade core and adapters together and stop all
older writers before opening the upgraded Wallet. Mixed-version writing and downgrade are
unsupported: IndexedDB versions reject old opens, but SQL cannot retroactively fence an old binary.
Schema upgrades preserve history and deterministic counters; legacy submission provenance is
established conservatively before admitting new claims.
