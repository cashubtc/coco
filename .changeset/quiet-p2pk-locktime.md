---
'@cashu/coco-core': patch
---

Receive P2PK proofs without a signature once their locktime has expired and no refund condition
exists, including proofs whose original condition required multisig. Refund conditions continue
to require the original key. Evaluate eligibility during preparation and reuse the request during execution
and recovery.
Reject unsupported SIG_ALL and malformed spending conditions during preparation. No storage
migration is required.
