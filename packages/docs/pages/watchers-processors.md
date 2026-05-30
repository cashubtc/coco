# Watchers and Processors

By default, when using `initializeCoco()`, all watchers and processors are automatically enabled. If you're instantiating the `Manager` class directly, you can manually enable them:

```ts
await coco.enableMintOperationProcessor();
await coco.enableProofStateWatcher();
await coco.enableMintOperationWatcher();
```

`initializeCoco()` also recovers pending `coco.ops.send`, `coco.ops.receive`, and `coco.ops.melt`
operations during startup, so most apps do not need to trigger recovery manually.

To disable them during initialization with `initializeCoco()`:

```ts
const coco = await initializeCoco({
  repo,
  seedGetter,
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
  },
});
```

## MintOperationProcessor

This module processes live mint operation events. When a pending BOLT11 mint operation is observed
as `PAID`, the processor advances it by finalizing the operation. For reusable onchain mint quotes,
it claims locally available balance when quote updates show newly claimable funds.

## MintOperationWatcher

This module watches pending mint operations via WebSockets and polling, observes remote quote
state changes, and emits operation-based mint events. It supports BOLT11 mint quotes and reusable
onchain mint quotes. It does not finalize operations itself.

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
- All watchers (`MintOperationWatcher`, `ProofStateWatcher`) are stopped
- The `MintOperationProcessor` is stopped

### What happens during resume?

When `resumeSubscriptions()` is called:

- All subscriptions are re-established (WebSockets or polling)
- Watchers are restarted based on their original configuration
- The `MintOperationProcessor` is restarted if enabled
- Startup and resume backlog reconciliation are handled by mint operation recovery
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
