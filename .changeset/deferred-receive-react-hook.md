---
'@cashu/coco-react': minor
---

Surface deferred receives in `useReceiveOperation`: the hook binds deferred prepare
results, observes `receive-op:deferred` events, treats cancelled deferred operations like
cancelled inits, and adds `listDeferred()` / `redeemDeferred(filter?)` passthroughs.
