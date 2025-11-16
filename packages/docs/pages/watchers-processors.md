# Watchers and Processors

By default, when using `initializeCoco()`, all watchers and processors are automatically enabled. If you're instantiating the `Manager` class directly, you can manually enable them:

```ts
await coco.enableMintQuoteProcessor();
await coco.enableProofStateWatcher();
await coco.enableMintQuoteWatcher();
```

To disable them during initialization with `initializeCoco()`:

```ts
const coco = await initializeCoco({
  repo,
  seedGetter,
  watchers: {
    mintQuoteWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
  },
  processors: {
    mintQuoteProcessor: { disabled: true },
  },
});
```

## MintQuoteProcessor

This module will periodically check the database for "PAID" mint quotes and redeem them.

## MintQuoteWatcher

This module will check the state of mint quotes (via WebSockets and polling) and update their state automatically.

## ProofStateWatcher

This module will check the state of proofs known to coco and update their state automatically.

## Pausing and Resuming Subscriptions

For energy efficiency and battery savings (especially on mobile devices), you can pause and resume all subscriptions, watchers, and processors. This is particularly useful when your app is backgrounded or minimized:

```ts
// Pause all subscriptions, watchers, and processors
await coco.pauseSubscriptions();

// Resume all subscriptions, watchers, and processors
await coco.resumeSubscriptions();
```

### What happens during pause?

When `pauseSubscriptions()` is called:

- All WebSocket connections are closed immediately
- Reconnection attempts are disabled to save battery
- All watchers (`MintQuoteWatcher`, `ProofStateWatcher`) are stopped
- The `MintQuoteProcessor` is stopped

### What happens during resume?

When `resumeSubscriptions()` is called:

- All subscriptions are re-established (WebSockets or polling)
- Watchers are restarted based on their original configuration
- The `MintQuoteProcessor` is restarted and paid mint quotes are re-enqueued
- Everything returns to its previous state before pausing

### Use Cases

This feature is designed for scenarios where:

- Your app is backgrounded or minimized by the user
- The operating system might automatically close connections to save resources
- You want to explicitly save battery when real-time updates aren't needed
- You need to ensure proper functionality when the app is foregrounded again

### Important Notes

- Both methods are idempotent - calling them multiple times has no adverse effects
- Subscriptions created while paused will be automatically activated when resumed
- The resume operation ensures everything is running properly, even if connections were torn down by the OS
