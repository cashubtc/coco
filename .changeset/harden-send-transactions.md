---
'@cashu/coco-core': minor
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Route Send preparation, execution, completion, cancellation, and Operation Recovery through domain
transaction gateways so proof, counter, token, and operation transitions commit atomically while
remote mint requests remain outside repository transactions.

Share scoped proof and Output Allocation commands across Send transitions and pending-token reclaim.
Persist reclaim output plans separately from the original Send request, apply reclaim results
atomically, and preserve startup cleanup and existing recovery behavior for persisted operations.
