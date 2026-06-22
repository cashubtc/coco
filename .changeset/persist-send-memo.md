---
'@cashu/coco-core': minor
---

Allow attaching an optional memo when executing a send. `SendOpsApi.execute`
now accepts `ExecuteSendOptions` with a `memo`, which is persisted on the
executed send token.
