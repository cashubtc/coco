---
'@cashu/coco-core': patch
---

Add a melt settlement processor that tracks exact pending melt operation interest, reacts to
canonical melt quote updates, and advances interested operations through the existing melt saga
without introducing a retry queue.
