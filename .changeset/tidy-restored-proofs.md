---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Reconcile seed-based Restore proofs and counter high-water marks atomically per keyset.
Preserve existing proof state and ownership, make repeated Restore idempotent, and skip
pending proofs in Restore and Sweep. Publish Restore events after commit without letting
listener failures misreport persistence success. Add shared Restore adapter contracts.
