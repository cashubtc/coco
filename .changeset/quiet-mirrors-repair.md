---
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
---

Repair SQLite migration compatibility for databases that were opened by adapters with swapped
send/receive operation migration IDs.
