---
'@cashu/coco-core': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Make Mint preparation and proof settlement atomic through composable transaction transitions. Revalidate quote reservations inside issuance authorization, retain ambiguous executions for recovery, and publish events only after commit. Preserve coordinator-supplied Mint operation timestamps across storage adapters.
