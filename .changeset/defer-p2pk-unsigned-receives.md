---
'@cashu/coco-core': minor
---

Defer p2pk receives when the signing key is missing: `init` persists the operation as
`deferred` (reason `p2pk-unsigned`) with the raw unsigned proofs instead of throwing, and
signing is re-attempted at redemption time once the key ring holds the unlock key.
