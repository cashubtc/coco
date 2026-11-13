# Subscriptions

By default Coco will enable [Watchers & Processors](../pages/watchers-processors.md) when instantiating with the `initializeCoco` helper. Some of these services will try to establish a Websocket connection to the mint to receive live updates. If Websockets are unavailable for whatever reason Coco will fallback to polling.

Subscriptions are background observation controls. Application flows should use
typed manager events, quote refreshes, or operation APIs rather than raw
subscription helpers:

```ts
const off = coco.on('mint-quote:updated', ({ mintUrl, quoteId, quote }) => {
  if (mintUrl !== expectedMintUrl || quoteId !== expectedQuoteId) return;
  console.log('Quote updated:', quote);
});

off();
```

## Websocket Factory

Coco will try to use the global `WebSocket` object by default. As this is not available in all environments, you can also pass a `WebsocketFactory` via [CocoConfig](../pages/coco-config.md).
Here is an example of how to instantiate Coco with the popular Websocket implementation `ws` in NodeJS:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { WebSocket } from 'ws';

const coco = await initializeCoco({
  repo,
  seedGetter,
  webSocketFactory: (url) => new WebSocket(url),
});
```

## Foreground networking repair

Call `ensureSubscriptions()` when your app returns to the foreground. The OS may have silently
cut a WebSocket even when it still appears open.

```ts
await coco.ensureSubscriptions();
```

This replaces WebSocket connections, replays current logical subscriptions when replacements open,
and ensures polling timers are running. Registrations and callbacks survive, overlapping calls
coalesce, and polling retains its cadence without overlapping an in-flight request. Hybrid polling
runs at the fast interval until the new socket opens, then uses the slow interval.

The promise resolves once **local repair has been initiated**. It does not wait for remote
connectivity, observation catch-up, or operation completion, and is safe to call offline.
Watchers and processors keep their initial selection and interests. Repair does not
rerun startup discovery or Operation Recovery. Normal observations can still persist canonical
quote state and trigger enabled processors; requests already in flight may finish their commits.

### React Native

```ts
import { AppState } from 'react-native';

const listener = AppState.addEventListener('change', async (nextAppState) => {
  if (nextAppState === 'active') await coco.ensureSubscriptions();
});

// When the component or lifecycle owner unmounts:
listener.remove();
```

### Browser visibility

```ts
const onVisibilityChange = async () => {
  if (!document.hidden) await coco.ensureSubscriptions();
};
document.addEventListener('visibilitychange', onVisibilityChange);

// When the lifecycle owner is removed:
document.removeEventListener('visibilitychange', onVisibilityChange);
```

The React provider does not automatically invoke foreground repair. Register the appropriate
platform handler in your app. Select watchers and processors during initialization, and use `dispose()` for final shutdown. Repair is a no-op after Manager
disposal starts; a disposed Coco Session cannot be restarted.

## Migration from pause and resume

`Manager.pauseSubscriptions()` and `Manager.resumeSubscriptions()` have been removed, along with
`SubscriptionManager.pause()` / `resume()` (also reachable through plugin `ServiceMap.subscriptions`)
and the `subscriptions:paused` / `subscriptions:resumed` events. There is no deprecation shim or
replacement lifecycle event: initiating repair does not establish readiness.

Replace foreground resume calls with `await coco.ensureSubscriptions()`. Remove background pause
calls only after deciding your app's background policy. Repair preserves the session's fixed owners
and their interests; it never activates an owner omitted at initialization.
Replace teardown calls with `await coco.dispose()`.

This migration is **not behavior-equivalent** to background pause/resume. There is no replacement
for its coordinated background quieting: removing a background pause (including one delayed by a
grace period) leaves polling and enabled background work running, subject to OS scheduling.
`ensureSubscriptions()` never suspends them. There is no per-owner runtime toggle or global pause for transports and plugin registrations.
Final `dispose()` ends the Coco Session, so it is not temporary suspension.

Keep app-owned foreground catch-up separate and in the order your app requires. Plugin start/sync,
explicit quote refresh or operation recovery, and `requeuePaidMintQuotes()` are not performed by
`ensureSubscriptions()`. Its completion is not a barrier before which those tasks are synchronized.
See the [fixed-owner migration](../pages/watchers-processors.md#fixed-owner-migration).

The old resume path unconditionally ran standalone Mint and Batch Mint recovery. Repair deliberately
omits those sweeps. When your application needs explicit recovery, call it independently:

```ts
await coco.ops.mint.recovery.run();
await coco.ops.mint.batch.recovery.run();
```

Startup recovery in `initializeCoco()` remains unchanged. Plugins can initiate the same networking
repair with `await ctx.services.subscriptions.ensureSubscriptions()`. Injected `RealTimeTransport`
implementations must replace `pause()` / `resume()` with synchronous `ensure(): void`: initiate local
repair, preserve polling interests, fence retired callbacks, and emit `open` for each fresh connection
so current registrations can be replayed. Replayed subscriptions must not duplicate polling tasks.

See [Watchers & Processors](../pages/watchers-processors.md) for owner selection and shutdown behavior.
