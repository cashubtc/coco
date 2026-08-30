---
'@cashu/coco-core': patch
---

Upgrade cashu-ts to 5.0.0-rc.7, adopt its rotating proof selection, and keep Coco's persisted
keyset snapshots authoritative. A stale-keyset rejection now terminates the original operation,
marks the persisted mint snapshot stale, invalidates cached wallets, and propagates the cashu-ts
error. The next caller-created operation refreshes the mint through the normal time-to-live path.

Payment requests retain Coco's existing strict-list and gross-amount behavior; newly introduced
advisory-mint and supported-method semantics fail explicitly until the follow-up NUT-18 upgrade.
