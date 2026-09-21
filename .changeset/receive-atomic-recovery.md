---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-adapter-tests': patch
---

Make Receive preparation and settlement atomic through the shared Wallet transaction runner.
Preparation commits signed inputs, deterministic outputs, fees, and counter allocation together.
Settlement reconciles issued proofs and finalizes the operation in one transaction. Mint I/O and
seed/key access stay outside storage transactions; listener failures cannot fail a committed Receive.

Recovery reuses the exact persisted request. Pending, unknown, and replay rejections preserve
recovery material. A late initial rejection cannot roll back a newer recovery claim. Restore
matches exact output identities, supports mixed spent/unspent outputs and legacy partial saves,
and preserves later spending and reservations. Payment Request attempts link only durable children.

Existing Wallet and Receive APIs remain compatible. Legacy Receive requests, witnesses, source
metadata, and revisions survive storage upgrades.

### Custom storage adapters

`ReceiveOperationRepository` now requires `transition(input)`: atomically compare the stored state
and revision (missing legacy revisions mean zero), return `false` without writing on a mismatch,
and otherwise persist `next` with revision `expectedRevision + 1`. Reject a changed operation ID.
The transition must participate in the caller's repository transaction. Bundled adapters implement
this contract, and the shared adapter suite tests conditional transitions, rollback, and snapshots.
