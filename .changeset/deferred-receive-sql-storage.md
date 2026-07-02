---
'@cashu/coco-sql-storage': minor
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Persist deferred receive operations: migration `037_receive_operations_deferred` rebuilds
`coco_cashu_receive_operations` with a `deferred` state, `deferredReason`, and `batchId`
columns, and pending queries now include deferred operations.
