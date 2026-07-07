---
'@cashu/coco-core': major
---

Add a `deferred` state to the receive operation saga. Receives that cannot be settled yet
(dust below the swap fee, unreachable mints) are now modeled as
`DeferredReceiveOperation` with a `deferredReason`, and batched redemptions link members via
`batchId`. The `ReceiveOperationState` union and `ReceiveOperation` discriminated union are
widened, so downstream exhaustive state handling must account for `deferred`.
