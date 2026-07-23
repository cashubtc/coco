---
'@cashu/coco-core': minor
---

Add batched redemption for deferred receives: `redeemDeferred()` settles each viable
(mint, unit) group with one swap whose single NUT-02 fee is deterministically apportioned
across the members, while every member still finalizes as its own operation with its own
event and history entry. Groups below the combined fee stay queued. Queued members whose
inputs are already spent at the mint roll back before batching so one poisoned proof
cannot wedge the queue; on terminal mint errors spent members settle or roll back
individually while unspent members return to the queue, and a fresh receive that batched
with the queue falls back to a solo receive instead of failing. Recovery of an
interrupted batch re-executes the stored outputs only after verifying they still satisfy
the swap equation against a freshly computed fee.
