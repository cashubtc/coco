---
'@cashu/coco-core': minor
---

Throw a typed `KeyPairNotFoundError` (carrying the missing public key) from key ring
signing instead of a plain `Error`, so callers can branch on missing-key failures.
