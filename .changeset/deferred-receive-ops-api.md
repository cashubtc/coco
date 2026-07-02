---
'@cashu/coco-core': minor
---

Expose deferred receives through the ops API: `ops.receive.listDeferred()`,
`ops.receive.redeemDeferred(filter?)`, `cancel()` now accepts deferred operations, and
`listInFlight()` includes deferred alongside executing operations.
