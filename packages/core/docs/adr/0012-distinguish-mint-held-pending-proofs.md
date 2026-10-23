---
status: accepted
---

# Distinguish mint-held pending proofs from unclaimed sends

Use a local `pending` proof state for mint-held Melt inputs and newly restored proofs whose mint reports `PENDING`. Local
`inflight` also represents outgoing Send tokens that a recipient can still claim while the mint
reports `UNSPENT`; treating both cases identically would either strand restored proofs or make
outstanding Send tokens spendable again. Restore implements this distinction.

The initial migration preserves existing operation-owned proof state and ownership. Releasing a
restored pending proof after a fresh `UNSPENT` observation requires checking its current local state
and ownership inside the applying transaction. The proof remains unavailable until that release or
confirmation that it was spent.

Initially, re-running Restore provides reconciliation: eligible pending proofs remain pending on
`PENDING`, become ready on `UNSPENT`, and become spent on `SPENT`. Current local state and operation
ownership are rechecked inside the keyset transaction before applying an observation.

Automatic pending-proof watching is deferred to a separate change. That work must account for
subscription acquisition, replacement subscriptions, overlapping notifications, and shutdown,
including event publication through called services. This migration leaves the existing inflight
watcher and EventBus lifecycle unchanged.

Preserve existing balance semantics: pending proofs, like inflight proofs, contribute to none of
`spendable`, `reserved`, or `total` until they become ready. Separate pending balance reporting is
outside this migration.

Melt authorization records its inputs as `pending` in the same transaction that records execution,
before submitting either a pre-swap or direct Melt request. A successful pre-swap spends its original
inputs and persists its exact Melt inputs as operation-owned `pending` proofs in one transaction.
Ambiguous outcomes retain those proofs, their ownership, and the exact persisted request.

Only the owning Melt Operation may release these inputs after verified non-payment or settle them
after payment. An `UNSPENT` proof observation alone cannot release them, including during repeated
Restore. Existing persisted Melt inputs using `inflight` remain recoverable without a bulk rewrite;
legacy pre-swap outputs without reservation ownership still require their exact output plan and
creator to match. Outgoing Send proofs continue to use `inflight`.
