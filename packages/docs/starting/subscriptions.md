# Subscriptions

By default Coco will enable [Watchers & Processors](../pages/watchers-processors.md) when instantiating with the `initializeCoco` helper. Some of these services will try to establish a Websocket connection to the mint to receive live updates. If Websockets are unavailable for whatever reason Coco will fallback to polling.

## Websocket Factory

Coco will try to use the global `WebSocket` object by default. As this is not available in all environments, you can also pass a `WebsocketFactory` via [CocoConfig](../pages/coco-config.md).
Here is an example of how to instantiate Coco with the popular Websocket implementation `ws` in NodeJS:

```ts
import { initializeCoco } from 'coco-cashu-core';
import { WebSocket } from 'ws';

const coco = await initializeCoco({
  repo,
  seedGetter,
  webSocketFactory: (url) => new WebSocket(url),
});
```

## Managing Subscription Lifecycle

Coco provides APIs to pause and resume subscriptions for better resource management:

```ts
// Pause all subscriptions when app goes to background
await coco.pauseSubscriptions();

// Resume all subscriptions when app comes to foreground
await coco.resumeSubscriptions();
```

This is particularly useful for:

- **Mobile apps**: Save battery when the app is backgrounded
- **Web apps**: Reduce resource usage when the browser tab is hidden
- **Desktop apps**: Pause when the window is minimized

### Example: React Native App Lifecycle

```ts
import { AppState } from 'react-native';

// Listen for app state changes
AppState.addEventListener('change', async (nextAppState) => {
  if (nextAppState === 'background') {
    await coco.pauseSubscriptions();
  } else if (nextAppState === 'active') {
    await coco.resumeSubscriptions();
  }
});
```

### Example: Web Browser Visibility

```ts
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    await coco.pauseSubscriptions();
  } else {
    await coco.resumeSubscriptions();
  }
});
```

See [Watchers & Processors](../pages/watchers-processors.md) for more details on pause/resume behavior.
