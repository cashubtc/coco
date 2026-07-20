# Watchers and Processors

By default, when using `initializeCoco()`, all watchers and processors are automatically enabled. If you're instantiating the `Manager` class directly, you can manually enable them:

```ts
await coco.enableMintOperationProcessor();
await coco.enableMeltSettlementProcessor();
await coco.enableMintSwapOperationProcessor();
await coco.enableProofStateWatcher();
await coco.enableMintOperationWatcher();
await coco.enableMeltQuoteWatcher();
```

`initializeCoco()` also recovers pending `coco.ops.send`, `coco.ops.receive`, and `coco.ops.melt`
operations during startup, so most apps do not need to trigger recovery manually.
Mint-swap recovery runs after its owned children and before live watchers start.

To disable them during initialization with `initializeCoco()`:

```ts
const coco = await initializeCoco({
  repo,
  seedGetter,
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
    mintSwapOperationProcessor: { disabled: true },
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

## MeltQuoteWatcher

This module watches canonical pending melt quotes via WebSockets and polling, records remote quote
observations, and emits canonical `melt-quote:updated` events. It also keeps operation-owned quote
interest active for pending melt operations, including expired quotes, until settlement finalizes or
rolls back.

## MeltSettlementProcessor

This module reacts to canonical melt quote update events for interested pending melt operations and
advances them through the existing melt operation saga. It starts with existing pending melt
operations by default, suppresses concurrent checks for the same operation, and relies on later
quote notifications or manual refresh after transient failures.

## ProofStateWatcher

This module will check the state of proofs known to coco and update their state automatically.

## MintSwapOperationProcessor

This processor reconciles durable parent mint-swap states. Child and quote events wake exact
parents quickly, while periodic due-state sweeps close event-loss and restart windows. Retry timing
and event publication failures are persisted; retry counts never turn remote ambiguity into a
terminal result. It also publishes committed parent outbox events.

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
- All watchers (`MintOperationWatcher`, `MeltQuoteWatcher`, `ProofStateWatcher`) are stopped
- The `MintOperationProcessor`, `MeltSettlementProcessor`, and `MintSwapOperationProcessor` are stopped

### What happens during resume?

When `resumeSubscriptions()` is called:

- All subscriptions are re-established (WebSockets or polling)
- Watchers are restarted based on their original configuration
- Processors are restarted based on their original configuration
- Startup and resume backlog reconciliation are handled by operation recovery and watcher scans
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
