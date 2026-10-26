---
'@cashu/coco-core': patch
---

Treat omitted change on PAID Melt Quote responses as zero change, so a notification arriving before a PENDING HTTP response can finalize the Melt Operation. Forward full BOLT11 and BOLT12 responses from polling to preserve change signatures and avoid a redundant quote refresh.
