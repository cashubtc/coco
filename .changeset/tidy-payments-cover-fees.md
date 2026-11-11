---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': patch
---

Add `coverReceiverFees` to `ops.send.prepare()` to treat the amount as the receiver's net target
after redemption input fees. It defaults to false; Payment Requests enable it automatically.

Cover receiver redemption input fees when preparing Payment Requests, including unlocked and P2PK
payments, fixed and caller-chosen amounts, and direct or swap-backed sends. Reject incomplete
funding before delivery and commit the final reservations and output plan atomically. Try existing
proofs before planning unlocked swap outputs, so an uneconomic active keyset does not prevent a
direct payment using older proofs that already cover the receiver's fees.

Resolved requests retain their net amount and unit. Send amounts are gross outgoing value; the
existing Send fee remains the separate payer-side preparation cost. Sends that omit the option or
set it to false, and already prepared operations, keep their existing meaning. The plugin-reachable
Send service accepts the same optional policy through `prepare(operation, { coverReceiverFees })`.
Repository contracts and persisted formats are unchanged. No adapter or data migration is needed.

The shared adapter integration suite now verifies Payment Request fee coverage and recovery through
the public API with each adapter's repositories, including the selected custom unit.
