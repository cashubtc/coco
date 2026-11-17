---
'@cashu/coco-core': patch
---

Receive P2PK proofs using a single refund key after locktime when the original authorization
path is unavailable, including when the original condition requires multisig. Preserve the
original single-key path before and after expiry, and reuse the witness selected during
preparation for execution and recovery. No storage migration is required.
