---
'@cashu/coco-core': major
---

Defer dust and unreachable-mint receives instead of failing. `prepare` now transitions
init → `deferred` (reasons `dust` / `mint-unreachable`) and emits a new
`receive-op:deferred` event rather than throwing and deleting the operation.
`wallet.receive()` / `ReceiveOperationService.receive()` now return the finalized or
deferred operation (previously `Promise<void>`), `ops.receive.prepare()` can return a
deferred operation callers must branch on, and deferred operations can be cancelled via
rollback. Payment-request attempts whose child receive defers rest in `receiving` until a
later redemption sweep settles them.
