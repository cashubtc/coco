---
'@cashu/coco-core': patch
---

Keep subscription polling scheduled when a timer wakes before its deadline, and cancel pending polling timers when subscriptions are paused or closed.
