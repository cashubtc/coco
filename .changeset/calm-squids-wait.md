---
'@cashu/coco-core': patch
---

Expose operation ids on history entries so consumers can act on the underlying
operation directly.

History entries now persist their linked `operationId` where available, and the
core history API adds `getOperationIdForHistoryEntry()` for callers that only
have a history entry id. This makes flows like reclaiming a send from a history
item straightforward with the existing `manager.ops.*` APIs.
