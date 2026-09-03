---
'@cashu/coco-core': patch
---

Use Effect structured concurrency for mint operation scheduling, retry, and processor cleanup.
Operation requeues are now deduplicated through processing and retry, and scheduled work is
cancelled when its mint becomes untrusted.
