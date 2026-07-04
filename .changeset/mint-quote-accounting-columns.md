---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-sqlite': patch
---

Expose canonical mint quote accounting as first-class `amountPaid`, `amountIssued`, and nullable
`remoteUpdatedAt` fields.

Persistent adapters now store mint quote accounting in dedicated fields, migrate legacy BOLT11 quote
rows from compatibility state, preserve reusable quote accounting, and leave migrated remote update
time unset.
