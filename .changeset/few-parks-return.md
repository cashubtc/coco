---
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-core': patch
---

fix: prevent double JSON encoding of P2PK witness. KeyRingService now returns witness as object instead of string. ProofRepository checks type before JSON.stringify to prevent double-encoding. Fixes P2PK signature verification failure.
