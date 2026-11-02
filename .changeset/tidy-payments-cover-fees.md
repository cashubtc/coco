---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Cover receiver redemption input fees when preparing Payment Requests, including unlocked and P2PK
payments, fixed and caller-chosen amounts, and direct or swap-backed sends. Reject incomplete
funding before delivery and commit the final reservations and output plan atomically.

Resolved requests retain their net amount and unit. Send amounts are gross outgoing value; the
existing Send fee remains the separate payer-side preparation cost. Ordinary Send amounts and
already prepared operations keep their existing meaning. The plugin-reachable Send service adds
`preparePaymentRequest()` for this dedicated preparation policy; existing signatures, repository
contracts, and persisted formats are unchanged. No adapter or data migration is needed.

The shared adapter integration suite now verifies Payment Request fee coverage and recovery through
the public API with each adapter's repositories, including the selected custom unit.
