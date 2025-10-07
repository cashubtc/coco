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
