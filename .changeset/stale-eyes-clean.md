---
'coco-cashu-core': patch
---

Fix: added mint-level operation locking on proof selection to avoid race conditions in near-parallel execution

> [!WARNING]
> The lock is memory level and does not prevent race conditions in multi-process environments
