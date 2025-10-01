# Watchers and Processors

By default coco will not automatically watch for state updates or process pending mint quotes. However both can be enabled when instantiating the Manager class

```ts
await manager.enableMintQuoteProcessor();
await manager.enableProofStateWatcher();
await manager.enableMintQuoteWatcher();
```

## MintQuoteProcessor

This module will periodically check the database for "PAID" mint quotes and redeem them.

## MintQuoteWatcher

This module will check the state of mint quotes (via WebSockets and polling) and update their state automatically.

## ProofStateWatcher

This module will check the state of proofs known to coco and update their state automatically.
