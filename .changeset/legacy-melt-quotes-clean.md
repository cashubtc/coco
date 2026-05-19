---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
---

Remove the legacy `MeltQuoteService`, `MeltQuoteRepository`, and `melt-quote:*`
event API surface. Melts are now exposed through `manager.ops.melt`; existing
legacy melt quote storage is preserved for data compatibility.
