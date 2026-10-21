---
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Reuse shared SQL storage repository initialization and transaction handling in SQLite adapters while preserving their constructors and caller-owned database lifetimes.
