---
'@cashu/coco-core': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
---

Make an active Mint Swap the exclusive coordinator of its children. Ordinary Mint/Melt commands reject its children and quotes with `MintSwapChildOperationError.parentOperationId`; use `ops.mintSwap` instead. Reads and shared quote observation remain available. Ordinary processors, automatic claiming and generic recovery skip these children, so disabling the parent processor pauses automatic child progression.

Once the parent is terminal or `needs_attention`, its children return to ordinary resolution (recovery, release, settlement and claiming), so a stopped swap cannot strand reserved proofs or paid quotes. Ordinary commands never authorize a stopped parent's source payment; those rejections set `parentStopped: true`.

Add durable parent lookups by child and quote identity, including terminal parents, without a schema migration. Custom adapters must implement `MintSwapOperationRepository.getByChild` and `getByQuote`.
