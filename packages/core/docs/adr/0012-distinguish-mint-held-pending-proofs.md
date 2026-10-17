---
status: accepted
---

# Distinguish mint-held pending proofs from unclaimed sends

Add a local `pending` proof state for newly restored proofs whose mint reports `PENDING`. Local
`inflight` also represents outgoing Send tokens that a recipient can still claim while the mint
reports `UNSPENT`; treating both cases identically would either strand restored proofs or make
outstanding Send tokens spendable again. Restore and its watcher implement this distinction.

The initial migration preserves existing operation-owned proof state and ownership. Releasing a
restored pending proof after a fresh `UNSPENT` observation requires checking its current local state
and ownership inside the applying transaction. The proof remains unavailable until that release or
confirmation that it was spent.

Extend the existing proof watcher to discover pending proofs both live and after restart. Apply
fresh observations transactionally: eligible pending proofs remain pending on `PENDING`, become ready
on `UNSPENT`, and become spent on `SPENT`. Re-running Restore provides the same reconciliation when
background watchers are disabled. Current local state and operation ownership must be rechecked
before applying an observation.

Preserve existing balance semantics: pending proofs, like inflight proofs, contribute to none of
`spendable`, `reserved`, or `total` until they become ready. Separate pending balance reporting is
outside this migration.

Melt inputs retain `inflight` in this PR. Once the Restore PR is opened, create a linked follow-up
issue to move Melt inputs to `pending`, preserving the Melt Operation's authority over release and
settlement. Mint observation alone must not bypass an owning operation's recovery rules.
