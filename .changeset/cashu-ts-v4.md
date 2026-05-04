---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': major
---

Upgrade `@cashu/cashu-ts` to `4.1.0` and adapt core wallet flows to the v4
`Amount` API while preserving coco's numeric repository and operation models.

Token encoding now follows cashu-ts v4 options, so `WalletApi.encodeToken`
accepts `removeDleq` instead of the removed v3/v4 `version` selector.
