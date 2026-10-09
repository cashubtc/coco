---
'@cashu/coco-core': patch
---

Remove the unused internal EventBus parallel mode and concurrency option. Event delivery continues to await listeners sequentially in registration order, preserving listener error handling and per-emit overrides.
