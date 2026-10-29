---
'@cashu/coco-core': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-adapter-tests': patch
---

Make an active Mint Swap the exclusive coordinator of its children. Ordinary Mint/Melt commands that would change its children or use its quotes reject with `MintSwapChildOperationError.parentOperationId`; use `ops.mintSwap` instead. A command called in the wrong state for the child reports that state error first, and refresh reads a child it has nothing to resolve for. Reads and shared quote observation remain available. Ordinary processors, automatic claiming and generic recovery skip these children, so disabling the parent processor pauses automatic child progression.

Once the parent is terminal or `needs_attention`, its children return to ordinary resolution (recovery, release, settlement and claiming), so a stopped swap cannot strand reserved proofs or paid quotes. Ordinary commands never authorize a stopped parent's source payment; those rejections set `parentStopped: true`.

Extend the unreleased Mint Swap repository contract with durable `MintSwapOperationRepository.getByChild` and `getByQuote` lookups, including terminal parents, without a schema migration. The adapter conformance suite covers both.
