---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Make keyset comparison and persistence atomic in SQL and IndexedDB. Concurrent conflicting
`addKeyset` calls can no longer replace the winner's keys or metadata. Root writes own a
transaction; writes in a Wallet transaction reuse its scope and roll back with it.
