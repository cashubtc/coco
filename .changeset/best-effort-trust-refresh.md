---
'@cashu/coco-core': minor
---

A trust change now succeeds once committed even when the stale metadata refresh that follows it
fails; the stored metadata is published instead.
