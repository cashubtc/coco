# Watchers and Processors

By default, when using `initializeCoco()`, all watchers and processors are automatically enabled. If you're instantiating the `Manager` class directly, you can manually enable them:

```ts
await coco.enableMintOperationProcessor();
await coco.enableMeltSettlementProcessor();
await coco.enableProofStateWatcher();
await coco.enableMintOperationWatcher();
await coco.enableMeltQuoteWatcher();
```

`initializeCoco()` also recovers pending `coco.ops.send`, `coco.ops.receive`, and `coco.ops.melt`
operations during startup, so most apps do not need to trigger recovery manually.

Watchers observe the mint and persist canonical evidence before notifying processors. Processors
reassess persisted evidence at startup and on runtime events; event payloads do not override current
Wallet state. Mint and Melt watchers and processors can be enabled independently. With a processor
enabled and its watcher disabled, cached evidence or an explicit quote refresh can drive advancement.
With only the watcher enabled, observations update quotes without automatically advancing operations.
With both disabled, explicit operation APIs such as `refresh()` and `checkPayment()` remain available.
Startup recovery sweeps still run independently of these switches and can advance pending operations.

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
  },
});
```

## MintOperationProcessor

This module discovers locally claimable Mint Quotes and pending Mint Operations at startup, including
operations whose canonical quotes are already complete. It reassesses canonical accounting on quote
updates and newly pending operation events. It supports BOLT11, BOLT12 and onchain quotes, including
reusable quotes with remaining claimable value. Executing an eligible transition may issue proofs or
restore previously issued outputs; those effects are separate from observing quote state.

`autoClaimMintQuotes: false` suppresses the processor's startup and runtime automatic quote claims.
It still handles explicit operation requeue events. Disabling the processor suppresses both kinds
of processor-owned work.

## MintOperationWatcher

This module watches pending Mint Operations and Mint Quotes via WebSockets and polling, persists remote
observations, and emits canonical quote updates. It supports BOLT11, BOLT12 and onchain quotes. It does
not finalize operations itself.

## MeltQuoteWatcher

This module watches canonical pending melt quotes via WebSockets and polling, records remote quote
observations, and emits canonical `melt-quote:updated` events. It also keeps operation-owned quote
interest active for pending melt operations, including expired quotes, until settlement finalizes or
rolls back.

The Melt processor declares operation-owned observation interest synchronously. The watcher owns
asynchronous trust checks and subscription setup; registration means local acceptance, not readiness
or remote subscription acceptance. Enabling either owner can therefore return while setup for those
operation-owned interests is still pending. Cached-evidence progression does not wait for setup.

Setup failures are logged with quote and operation context. There is no new retry loop: another
pending-operation declaration can retry failed or skipped setup, while enabling the same running
watcher again retries failed setup only. An untrusted skip is not retried by that enable call.

Removing operation interest withdraws it immediately and waits for any cleanup it requires. Canonical
and other operation interests keep shared watches active. Stopping or untrusting the watcher
invalidates affected records before waiting for acquisition and unsubscribe cleanup, including records
already being retired. Old acquisitions and callbacks cannot take ownership of replacement watches.

## MeltSettlementProcessor

This module reacts to canonical melt quote update events for interested pending melt operations and
advances them through the existing melt operation saga. It starts with existing pending melt
operations by default, suppresses concurrent checks for the same operation, and relies on later
quote notifications or manual refresh after transient failures.

The processor uses cached canonical settlement evidence without fetching fresh quote state to decide
eligibility. Waiting quotes and incomplete cached PAID change leave operations pending. Complete
matching PAID observations normalize omitted change to empty change at the observation boundary;
incomplete stored evidence must be enriched by a valid observation or explicit refresh. Settlement
still validates quote identity and proof ownership through the operation service and may fetch
metadata to unblind change.

`initializeExistingPendingOperationsOnStart: false` skips startup discovery while preserving listeners
for newly pending operations and subsequent quote observations.

## ProofStateWatcher

This module observes inflight proof state and invokes the Send operation service for completion. Its
startup scan also discovers pending Sends whose proofs are already locally spent and supported legacy
tokenless P2PK Sends whose output proof rows were not retained. Legacy completion still requires the
original input metadata and exact output allocation; it does not fabricate proofs or a token.

`watchExistingInflightOnStart: false` skips the startup proof and Send scan. Live proof events and newly
pending Sends remain observed while the watcher runs.

`await coco.disableProofStateWatcher()` stops accepting new notifications and discovery work, cancels
pending discovery timers, and releases subscriptions, including those acquired during shutdown. It
waits for subscription acquisition and cleanup, but does not wait for already-started notification
processing or operation checks. These calls can finish Wallet updates and publish events after the
watcher stops. An event listener can therefore await `disableProofStateWatcher()` without waiting on
its own completion. A restarted watcher does not resume discovery or accept subscription callbacks
from its previous run.

The same proof-watcher behavior applies when `coco.dispose()` disables it. Neither method cancels
already-started proof updates or Send completion; shutdown is not a completion barrier for those
operations. Keep caller-owned storage available while such work finishes. Other watchers and
processors retain their own shutdown behavior.

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
- The `MintOperationProcessor` and `MeltSettlementProcessor` are stopped

### What happens during resume?

When `resumeSubscriptions()` is called:

- All subscriptions are re-established (WebSockets or polling)
- Watchers are restarted based on their original configuration
- Processors are restarted based on their original configuration
- Startup and resume backlogs are handled by operation recovery, watcher scans, and processor discovery
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
