---
'@cashu/coco-core': minor
---

Add batched redemption for deferred receives: `redeemDeferred()` settles each viable
(mint, unit) group with one swap whose single NUT-02 fee is deterministically apportioned
across the members, while every member still finalizes as its own operation with its own
event and history entry. P2pk members are re-signed once their key exists, groups below
the combined fee stay queued, and on terminal mint errors spent members settle or roll
back individually while unspent members return to the queue.
