---
'@cashu/coco-core': minor
---

Trigger deferred receive redemption automatically: an incoming `receive()` drains queued
deferred operations of the same mint and unit into its own batched swap (this is how
queued dust becomes redeemable), and the receive recovery sweep — already run at startup
and via `ops.receive.recovery.run()` — finishes by attempting to redeem every queued
group, tolerating unreachable mints.
