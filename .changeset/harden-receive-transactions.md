---
'@cashu/coco-core': minor
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Route Receive preparation, result application, replay, Restore, and Operation Recovery through
domain transaction gateways so output, proof, and operation transitions commit atomically while
remote mint requests remain outside repository transactions.

Reuse shared scoped proof, deterministic-output, and mint-metadata commands. Preserve exact signed
requests across replay and legacy revision migration, and isolate nested in-memory request data.

Persist Payment Request Receive children before linking attempts so interrupted claims and recovery
can resume without requiring payload redelivery.
