---
'@cashu/coco-core': patch
---

Recover executing melt operations from `manager.ops.melt.refresh()` so long-running
clients can resolve stuck melts without waiting for a startup recovery sweep.
