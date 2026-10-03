---
'@cashu/coco-core': major
---

Remove `historyService.getOperationIdFromHistoryEntry()` from the plugin service interface.
Plugins can use `getHistoryEntryById()` and read `operationId`, retaining their own send-only
validation if needed. The application lookup `manager.history.getOperationIdForHistoryEntry()`
continues to support every history type, trim IDs, and return `null` for missing or blank IDs.
