---
'@cashu/coco-core': patch
---

Prevent inherited `valueOf()` from exposing transaction repositories that remain usable after commit or rollback. Found by Project Loupe.
