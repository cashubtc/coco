---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Restore `Amount` instances when persisted melt change signatures are loaded by SQL and IndexedDB
adapters, including change stored by earlier IndexedDB releases.
