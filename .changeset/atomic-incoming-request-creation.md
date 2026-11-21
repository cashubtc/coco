---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Prevent concurrent wallet sessions from creating two active payment requests with the same ID. Keep payments received during transport activation when activation fails.
