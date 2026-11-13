---
status: accepted
---

# Distinguish mint-held pending proofs from unclaimed sends

Restored proofs whose mint reports `PENDING` are stored in a local `pending` proof state. Local
`inflight` also represents outgoing Send tokens that a recipient can still claim while the mint
reports `UNSPENT`; treating both cases identically would either strand restored proofs or make
outstanding Send tokens spendable again.

Existing operation-owned proofs keep their state and ownership. A pending proof remains unavailable
until a fresh `UNSPENT` observation releases it or it is confirmed spent. Releasing it requires
checking its current local state and ownership inside the applying transaction.

Re-running Restore is the reconciliation path: eligible pending proofs remain pending on `PENDING`,
become ready on `UNSPENT`, and become spent on `SPENT`. Current local state and operation ownership
are rechecked inside the keyset transaction before applying an observation.

There is no automatic pending-proof watching. Adding it is a separate decision that must account for
subscription acquisition, replacement subscriptions, overlapping notifications, and shutdown,
including event publication through called services.

Pending proofs, like inflight proofs, contribute to none of `spendable`, `reserved`, or `total`
until they become ready. There is no separate pending balance.

Melt inputs retain `inflight`. Moving them to `pending` would have to preserve the Melt Operation's
authority over release and settlement: mint observation alone must not bypass an owning operation's
recovery rules.
