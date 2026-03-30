---
'coco-cashu-expo-sqlite': patch
'coco-cashu-sqlite-bun': patch
'coco-cashu-indexeddb': patch
'coco-cashu-sqlite3': patch
'coco-cashu-core': patch
'coco-cashu-adapter-tests': patch
---

Finish the mint quote removal migration and make mint operations the runtime source of truth.

- Replace legacy `mint-quote:*` runtime events with operation-based mint events.
- Rename watcher and processor config and manager methods to the operation-based surface:
  `mintOperationWatcher`, `mintOperationProcessor`, `enableMintOperationWatcher()`,
  `enableMintOperationProcessor()`, and related disable/wait helpers.
- Remove the legacy `MintQuoteService` runtime path and keep `MintQuoteRepository` only for
  cold-start reconciliation of old persisted quote rows.
- Move mint watcher, processor, history, and recovery flows onto `manager.ops.mint`.

This is a breaking change for consumers using the old mint watcher/processor config keys,
manager methods, or `mint-quote:*` events.
