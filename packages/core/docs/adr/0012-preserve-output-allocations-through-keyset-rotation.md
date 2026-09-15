---
status: accepted
---

# Preserve Output Allocations through keyset rotation

Coco upgrades cashu-ts to 5.0.0-rc.9 and supplies strict, filtered keyset snapshots. cashu-ts owns
protocol validation; Coco owns persisted Output Allocations, metadata freshness, and operation
outcomes. BLS keysets remain excluded until all proof-state lookups support their curve.

## Decision

A metadata refresh never replaces an operation's outputs. Submission and unblinding select the
keyset recorded in those outputs. Inactive keys remain available for Restore. Unknown token keysets
trigger at most one forced metadata refresh before unit resolution and proof validation.

A keyset rejection invalidates the mint's snapshot. Persisted metadata revisions prevent refreshes
started before invalidation from restoring freshness. These writes use the metadata gateway,
preserve current trust, and keep remote I/O outside transactions. Wallet Instances compare the
committed revision before cache reuse.

For a first Send submission, rejection, proof release, and invalidation commit together. A first
reclaim rejection returns the Send to pending with its token and proofs intact; its discarded
reclaim allocation's counters remain consumed. Receive's first rejection records rolled_back.

Mint Operations persist `hasSubmitted` before issuance. Only an explicitly never-submitted claim
can become a retryable `stale_keyset` failure. A successor may claim that fixed quote, subject to
normal claimability checks. Missing markers on legacy operations mean the submission history is
unknown, not that issuance never happened.

A rejection of a replay cannot rule out an earlier submission still completing. Send, Receive, and
Mint recovery therefore retain the exact output plan and in-flight state on stale replay rejection.
Applications must continue recovery or Restore for those operations, rather than creating a second
payment on the strength of the error. No operation automatically regenerates outputs.

Melt keeps its existing quote/proof reconciliation. Its direct adapter exposes raw mint errors;
only the pre-melt swap uses cashu-ts Wallet. Invalidation precedes reconciliation, and an existing
pending or finalized result is returned when recovery establishes it.

## Compatibility

SQL migrations add a metadata revision (default zero) and nullable Mint submission marker. Existing
IndexedDB rows need no index migration; absent fields retain the same conservative defaults.
Legacy operation persistence remains an incremental migration under ADR-0011; this upgrade does not
redesign Mint/Receive/Melt finalization or ambiguous Send reclaim recovery.
Mint and Receive execution still use session-local locks. The submission marker preserves history
across restart; it does not provide cross-session execution fencing.

Payment Request construction uses the new options object. Coco retains its existing strict-mint
and payment accounting behavior. Requests requiring advisory mint lists or payment-method fees are
rejected explicitly until Coco models their fulfillment. An advisory flag without a mint list is
ignored as specified by NUT-18. cashu-ts now limits Amount values to uint64.

## Alternatives

We rejected retrying with newly generated outputs, which could lose recovery identity after an
ambiguous submission. We also rejected a freshness timestamp alone: a delayed refresh can overwrite
invalidation, and same-second timestamps cannot distinguish two observations. A durable revision
provides the ordering without depending on process-local locks or wall-clock uniqueness.
