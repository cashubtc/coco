---
'@cashu/coco-core': minor
---

idempotent Send prepare: create-or-join inside the transaction

`SendOpsApi.prepare()` is now idempotent for caller-supplied operation IDs. When the same
`send:<id>` is prepared again, the create-or-join decision runs inside the `prepareSend`
transaction:

- a repeat with the same intent (normalized mint, amount, unit, method, and method data) joins the
  existing `prepared` operation and reserves no new proofs;
- a repeat with a different intent throws `SendOperationIntentConflictError`;
- a repeat for an ID that has progressed past `prepared` throws `SendOperationConflictError`.

The decision lives in the transaction, so it holds across restarts and concurrent writers instead
of relying on a pre-transaction read or a process-local lock.
