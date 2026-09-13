---
'@cashu/coco-core': patch
---

Make mint add, forced metadata refresh, trust changes, and deletion use transaction gateways.
Commit mint metadata and keysets atomically, preserve concurrent trust changes during refresh,
and keep listener failures from rejecting committed mint mutations.
