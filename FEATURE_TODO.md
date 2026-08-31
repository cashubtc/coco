# Core Transaction Hardening: Strong Wallet Scopes (#447)

- [x] Read issue #447, the accepted transaction design, ADR-0011, and Coco Cashu vocabulary.
- [x] Confirm the implementation branch starts from `integration/core-transaction-hardening`.
- [x] Run the shared repository transaction contract against the memory adapter.
- [x] Make memory transactions stage writes and commit or roll back atomically.
- [x] Add isolation and writer-contention cases to the shared adapter contract.
- [x] Add a typed transient repository transaction conflict.
- [x] Make SQL-backed repository transactions acquire the strong writer scope.
- [x] Verify IndexedDB uses one read-write scope for the complete repository transaction.
- [x] Run focused tests, typechecks, builds, and the two-axis review.
- [x] Reconcile review findings with issue #447 and the accepted transaction design.
- [x] Include keypair allocation in the scoped repository foundation without migrating orchestration.
- [x] Defend IndexedDB strong scopes against ambient nesting and preserve legacy root-call behavior.
- [x] Cover clean core test startup, serializing writers, and coded SQLite callback conflicts.

## Scope boundary

Preserve existing repository callers. Do not migrate Keypair, Send, Receive, Mint Swap, or other
orchestration, and do not introduce network fault injection or durable event delivery.
