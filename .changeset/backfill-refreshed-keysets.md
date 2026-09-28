---
'@cashu/coco-core': patch
---

Backfill empty stored keysets with verified mint keys during stale metadata refresh. Commit
keys and mint metadata together, preserving populated keys and publishing events after commit.
