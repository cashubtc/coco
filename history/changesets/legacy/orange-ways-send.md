---
'coco-cashu-adapter-tests': patch
'coco-cashu-expo-sqlite': patch
'coco-cashu-sqlite3': patch
'coco-cashu-core': patch
---

Fix: Migrate from deprecated sqlite3 package to better-sqlite3

Fix: Made sure bootstrap inflight check finalizes send operations when proofs are returned spent.

WARNING: This is a breaking change for bun environments, as bun currently does not support the better-sqlite3 binding! Bun consumers should use the sqlite-bun adapter instead!!
