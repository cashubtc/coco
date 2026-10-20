---
status: accepted
---

# Distinguish mint-held pending proofs from unclaimed sends

Add a local `pending` proof state for newly restored proofs whose mint reports `PENDING`. Local
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

Automatic reconciliation uses a dedicated internal PendingProofWatcherService under Manager's
existing proof-state watcher setting. It watches only unowned pending proofs at trusted mints,
leaving Send and Melt observation under their existing coordinators. Subscription keys are reserved
before acquisition, revalidated after acquisition, and removed before publishing state changes.
Mint observations queue through local commit and recheck state and ownership in that transaction.

Shutdown invalidates callbacks, releases subscriptions acquired during shutdown, and drains local
writes. Post-commit publication stays outside that drain: a cancellation signal stops delivery before
the next event listener, while already-running application listeners may finish or await shutdown.
This avoids extending cancellation through Send/Melt services. The legacy inflight watcher's
lifecycle remains unchanged.

Preserve existing balance semantics: pending proofs, like inflight proofs, contribute to none of
`spendable`, `reserved`, or `total` until they become ready. Separate pending balance reporting is
outside this migration.

Melt inputs retain `inflight` in this PR. Once the Restore PR is opened, create a linked follow-up
issue to move Melt inputs to `pending`, preserving the Melt Operation's authority over release and
settlement. Mint observation alone must not bypass an owning operation's recovery rules.
