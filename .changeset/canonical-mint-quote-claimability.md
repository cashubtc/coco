---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Centralize Mint Quote Claimability on canonical accounting so atomic BOLT11 and balance-based
BOLT12/on-chain callers share readiness, reservation, scheduling, and recovery behavior. Make
explicit mint execution retry-safe when background processing has already started or completed it.
