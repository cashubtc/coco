---
'@cashu/coco-core': major
'@cashu/coco-react': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-adapter-tests': major
---

Project history entries from operation repositories instead of maintaining a
mutable history table.

History entries now use deterministic `type:operationId` ids for operation
rows, expose `source`, `updatedAt`, and `operationId` on operation-backed
entries, and retain legacy table rows behind `legacy:*` ids for migration
compatibility. The old history repository mutation contract has been removed;
persistent adapters now read history by merging operation rows with legacy rows
and de-duplicating legacy records that map to an operation.
