---
'@cashu/coco-core': patch
---

Upgrade cashu-ts to 5.0.0-rc.7, adopt its rotating proof selection, and keep Coco's persisted
keyset snapshots authoritative. Stale output keysets now reconcile and terminate the original
operation before refreshing the mint, while ambiguous outcomes require recovery instead of
inviting an unsafe retry.

Payment requests retain Coco's existing strict-list and gross-amount behavior; newly introduced
advisory-mint and supported-method semantics fail explicitly until the follow-up NUT-18 upgrade.
