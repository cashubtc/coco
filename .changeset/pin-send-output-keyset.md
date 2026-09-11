---
'@cashu/coco-core': patch
---

Pin Send swaps and pending-token reclaim to their persisted output keyset so a newly preferred mint
keyset cannot cause signatures to be unblinded with the wrong keys. Reject empty or mixed-keyset
output plans before contacting the mint.
