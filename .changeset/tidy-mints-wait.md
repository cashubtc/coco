---
'@cashu/coco-core': patch
---

Keep the Mint Operation execution lock until issuance or recovery finishes so concurrent callers
in the same Coco Session wait for proofs to be committed before returning.

Publish issuance and recovery events after releasing the lock so asynchronous settlement listeners
can await the same Mint Operation without deadlocking.
