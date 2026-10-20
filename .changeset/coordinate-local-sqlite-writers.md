---
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
---

Avoid blocking the JavaScript thread when SQLite connections contend with another local transaction on the same database. Preserve native waiting for external writers, bounded transaction retries, and each connection's configured busy timeout after each transaction.
