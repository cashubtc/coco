---
'@cashu/coco-core': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-adapter-tests': patch
---

Make an active Mint Swap the exclusive coordinator of its children. Ordinary Mint/Melt commands that would change a child or use its quote reject with `MintSwapChildOperationError`; pass its `parentOperationId` to `ops.mintSwap`. Reads and quote observation remain available, and ordinary processors, claiming and recovery leave these children to the parent, so disabling the parent processor pauses them. Once the parent is terminal or `needs_attention`, its children return to ordinary resolution, but no ordinary command authorizes its source payment (`parentStopped: true`).

Extend the unreleased Mint Swap repository contract with durable `getByChild` and `getByQuote` lookups, covered by the adapter conformance suite; no schema migration is needed.
