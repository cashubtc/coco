---
'@cashu/coco-core': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
---

Make Mint Swap the exclusive coordinator of its children. Ordinary Mint/Melt commands reject owned children and quotes with `MintSwapChildOperationError.parentOperationId`; use `ops.mintSwap` instead. Reads and shared quote observation remain available. Ordinary processors, automatic claiming and generic recovery skip owned children, so disabling the parent processor pauses automatic child progression.

Add durable parent lookups by child and quote identity, including terminal parents, without a schema migration. Custom adapters must implement `MintSwapOperationRepository.getByChild` and `getByQuote`.
