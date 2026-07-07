---
'@cashu/coco-core': patch
---

Serialize concurrent receive `prepare()` per mint with the shared `MintScopedLock`. Receive was left out of the mint-level lock added for proof selection, but it shares the same non-atomic NUT-13 counter derivation, so two concurrent receives on one mint could read the same counter and derive colliding deterministic outputs, failing with "Failed to persist proofs".
