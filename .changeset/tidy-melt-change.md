---
'@cashu/coco-core': patch
---

Treat omitted change on complete PAID Melt Quote notifications as zero change, so a notification arriving before a PENDING HTTP response can finalize the Melt Operation without an unnecessary refresh.
