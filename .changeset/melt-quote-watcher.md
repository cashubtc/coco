---
'@cashu/coco-core': patch
---

Improve melt quote watcher subscription lifecycle by coalescing overlapping watch starts, normalizing full subscription payload amounts, and clearing expired canonical interest while preserving operation-owned watches.
