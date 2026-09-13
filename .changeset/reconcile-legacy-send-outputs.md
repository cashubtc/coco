---
'@cashu/coco-core': patch
---

Recover legacy ready Send outputs by marking them inflight atomically with their pending token,
preventing the same proofs from remaining available for another Send. Preserve change proof state
and ownership, reject conflicting send-output reservations, and notify proof watchers after commit.
