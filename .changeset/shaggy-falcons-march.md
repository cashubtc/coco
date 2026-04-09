---
'@cashu/coco-core': patch
---

Preserve melt history entry units and amounts as quotes move through prepared,
pending, finalized, and rolled-back operation states.

This keeps `manager.history.*` melt entries aligned with the underlying melt
operation data instead of falling back to incorrect defaults during history
updates.
