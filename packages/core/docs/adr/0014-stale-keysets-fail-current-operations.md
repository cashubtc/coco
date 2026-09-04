# Stale keysets fail current operations

Status: accepted

When a mint rejects an Exact Operation Request built from a stale Wallet Keyset Snapshot, Coco
uses that structured rejection as proof that the request was not applied. Coco rolls the operation
back, releases its resources, marks the Known Mint stale, invalidates its Wallet Instances, and
propagates cashu-ts's `StaleKeysetError`. The caller creates a new operation with a new Output
Allocation; normal Wallet Instance creation refreshes the Known Mint on that next attempt.

## Considered Options

We rejected replacing outputs inside the original operation because that would make its persisted
request mutable. We also rejected automatically creating linked successor operations because the
additional lineage, retry-loop, persistence, and API machinery is disproportionate to requiring an
explicit caller retry.

We rejected synchronous reconciliation and mint refresh for a structured stale-keyset rejection.
The mint has already given a definitive response, so follow-up proof or quote requests add failure
modes without making rollback safer. A network failure during an eager refresh would also turn a
terminal rejection into an unnecessarily blocked recovery path.

## Consequences

Coco does not automatically retry or replace an operation after a stale-keyset rejection. A caller
may create a new operation only after the prior operation has safely reached its existing terminal
state. Send, receive, and melt operations use their existing `rolled_back` state; mint operations
use their existing structured terminal-failure field. No operation states, lineage fields, or
repository migrations are added.

A failed mint operation is a definitive non-issued outcome and no longer owns its fixed quote.
Creating a successor remains blocked while any sibling operation for that quote is `init`, `pending`,
`executing`, or `finalized`; the duplication rule does not inspect operation-specific failure codes.

After local rollback, Coco sets the Known Mint's freshness timestamp to a stale value and clears its
Wallet Instance cache. The next operation reaches the existing time-to-live refresh path and builds
from the new Wallet Keyset Snapshot. A cache generation prevents a Wallet Instance build that began
before invalidation from restoring stale data afterward.

Coco propagates cashu-ts's `StaleKeysetError` rather than introducing a parallel public error. Melt
requests call the mint adapter directly, so Coco also normalizes a structured 12xxx
`MintOperationError` from that path into cashu-ts's stale-keyset error while preserving the original
error as its cause.

`UnknownKeysetError` and `MeltChangeError` are not aliases for Stale Keyset Failure. Coco routes
them through operation-specific recovery because an unknown input keyset or already-paid melt may
make a new operation unsafe.

Those broader recovery cases keep their existing generic operation-recovery behavior and remain
separate follow-up work. An Ambiguous Operation Outcome still retains its resources until recovery
can establish a safe result.
