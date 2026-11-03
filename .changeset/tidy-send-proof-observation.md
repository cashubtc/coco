---
'@cashu/coco-core': major
---

Move proof observation and completion decisions into Send, preserving atomic proof updates and Send completion. Keep watcher lifecycle and supported legacy tokenless P2PK Send recovery.

Retire automatic reconciliation of unowned inflight proofs, including records referencing missing or terminal operations. Those historical records remain unchanged. Restore's unowned ready and pending proofs are unaffected. No persistence migration is required.

Send's plugin-reachable service adds `applyProofStateObservation`, `advancePendingOperation`, and informational `getProofObservationTargets`; `recordProofSpent` remains supported. Observations must be trusted mint evidence for the exact Send. No general proof mutation service is exposed.
