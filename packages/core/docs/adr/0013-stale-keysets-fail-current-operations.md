# Stale keysets fail current operations

Status: accepted

When a mint rejects an Exact Operation Request built from a stale Wallet Keyset Snapshot, Coco
preserves the failed request. Once the rejection or Operation Recovery proves that the request was
not applied, Coco rolls the operation back, releases its resources, refreshes the Known Mint, and
reports a Stale Keyset Failure. The caller creates a new operation with a new Output Allocation.

## Considered Options

We rejected replacing outputs inside the original operation because that would make its persisted
request mutable. We also rejected automatically creating linked successor operations because the
additional lineage, retry-loop, persistence, and API machinery is disproportionate to requiring an
explicit caller retry.

## Consequences

Coco does not automatically retry or replace an operation after a stale-keyset rejection. A caller
may create a new operation only after the prior operation has safely rolled back. An Ambiguous
Operation Outcome retains its resources and is not reported as retryable until recovery proves the
request was not applied. Coco returns its stable `StaleKeysetError`, including the failed operation
ID, only after synchronous rollback and Known Mint refresh succeed; the upstream error remains its
cause. Cleanup failure instead produces `OperationRecoveryRequiredError`, including the operation
ID, mint URL, unit, and failure cause.

The crash-safe order is to persist the Known Mint refresh requirement, prove and persist safe
operation rollback with resource release, and then force the refresh. Coco returns
`StaleKeysetError` only after all three steps complete. An interruption therefore leaves either a
recoverable operation or a Known Mint that cannot be mistaken for fresh.

`UnknownKeysetError` and `MeltChangeError` are not aliases for Stale Keyset Failure. Coco routes
them through operation-specific recovery because an unknown input keyset or already-paid melt may
make a new operation unsafe.

Existing `failed` and `rolled_back` states represent the persisted terminal outcome; this decision
does not add operation states, lineage fields, or repository migrations. Mint operations use their
existing structured terminal-failure field. Other operations retain their existing error text,
while runtime callers receive the structured Coco error. Existing operation events and structured
logs report the outcome; this upgrade does not add a public stale-keyset event.

A `MeltChangeError` resumes the persisted melt: finalized recovery returns success, pending recovery
returns the pending operation, and an unresolved outcome remains recovery-required. An
`UnknownKeysetError` forces one Known Mint refresh; if the keyset is still unknown, Coco safely
rolls back where possible and reports `KeysetSyncError` rather than inviting a stale-output retry.
