---
'@cashu/coco-core': patch
---

Keep the Mint Operation execution lock until issuance or recovery finishes so concurrent callers
in the same Coco Session wait for proofs to be committed before returning.
