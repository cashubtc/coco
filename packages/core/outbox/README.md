# Durable event outbox foundation

This module stores local event intent in the same physical transaction as authoritative state. It
is generic: it does not own a root transaction, a wallet feature, a scheduler, or an external
transport.

## Version 1 contract

- A logical event is identified by `(streamId, streamRevision, consumerId, eventKey)`.
- A sealed revision contains the complete event set for one stream revision. A semantic retry can
  use new event IDs, but all logical content must be identical.
- A worker claims only an exact `(consumerId, eventType, envelopeVersion, payloadVersion)` contract.
- Delivery is at least once. A worker can enter a consumer again after an earlier transaction rolls
  back or its commit result is unknown. The lease token prevents a stale attempt from committing
  after another worker owns the claim.
- A supported local consumer effect is effectively once only when the effect and
  `markPublished()` use the same transaction and the effect is idempotent or revision-guarded.
  Network calls, callbacks, analytics, and other external effects are outside this guarantee.
- Published payload rows can be deleted only through authorized compaction. The stream checkpoint
  remains and prevents an old revision from being inserted again.

## Host binding

The host opens and commits the root transaction. It binds the feature repositories and the narrow
outbox writer to the same transaction handle. The outbox repository must not open another root
transaction or retry the callback. The host can retry only a conflict known not to have committed,
and it must reuse stable IDs, time values, revision data, and payload inputs.

For a consumer, the host supplies one transaction scope containing the local effect repositories
and `DurableEventOutboxConsumerWriter`. An error from either the effect or publication
acknowledgement must roll back both writes.

## Operational defaults

- Events: 10,000 rows
- Revision seals: 10,000 rows
- Streams: 2,000
- Canonical payload storage: 64 MiB
- Published retention: 30 days
- Retry: 5 failures, exponential delay from 1 second to 5 minutes, 20% jitter
- Lease: 30 seconds
- Publisher batch: 25
- Warnings: 80% of any capacity limit or 100 blocked rows

Hosts can configure finite storage limits and publisher/retry values. Retention is a compaction
policy, not an automatic deletion timer. A host must not lower storage limits below current use.

## Rollout and recovery

1. Deploy the schema and a consumer that can process every activated contract.
2. Inspect outstanding contract counts and blocked rows.
3. Enable the producer only after all active adapters pass their transaction tests.
4. Requeue blocked work in bounded batches after the deterministic cause is fixed.
5. Compact published revisions only after retention has elapsed and the authoritative stream
   revision confirms the requested checkpoint.

To roll back a writer, first stop event production and drain or preserve its backlog. Older code can
ignore the additive tables, but a writer that does not seal revisions must not run against a stream
already managed by the outbox. Removing retained rows requires a separate destructive migration.

The likely first adoption is the local wallet history projector for a finalized wallet operation.
That is adoption context only; this foundation does not register or depend on that consumer.
