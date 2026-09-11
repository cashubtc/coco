---
'@cashu/coco-core': patch
---

Commit stale mint metadata and keysets atomically through a shared refresh action.
Reuse fresh cached metadata and known mint keys, preserve mint trust, and publish
refresh events after commit so listener failures cannot invalidate a successful refresh.
