---
'@cashu/coco-core': patch
---

Receive P2PK proofs with any listed original key when one signature suffices. After locktime
expiry, the Wallet can also sign with any listed refund key when the refund threshold is one,
including when the original path requires multiple signatures. Preparation prefers original
keys, reuses key lookups across proofs in the same token, and saves each witness for execution
and recovery. No storage migration is required.
