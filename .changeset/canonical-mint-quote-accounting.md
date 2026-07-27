---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-adapter-tests': major
---

Expose canonical Mint Quote Accounting through first-class `amountPaid`, `amountIssued`, and
nullable `remoteUpdatedAt` fields for every built-in mint method. Keep BOLT11 `state` as a
deprecated compatibility projection, derive legacy quote shapes at the lifecycle boundary, and
persist the canonical fields across memory, SQL, and IndexedDB repositories with conservative
legacy backfills.
