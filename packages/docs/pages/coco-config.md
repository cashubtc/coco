# Configuring Coco

Coco can be configured using a configuration object `CocoConfig`

```ts
export interface CocoConfig {
  repo: Repositories;
  seedGetter: () => Promise<Uint8Array>;
  logger?: Logger;
  webSocketFactory?: WebSocketFactory;
  plugins?: Plugin[];
  watchers?: {
    mintQuoteWatcher?: {
      disabled?: boolean;
      watchExistingPendingOnStart?: boolean;
    };
    proofStateWatcher?: {
      disabled?: boolean;
    };
  };
  processors?: {
    mintQuoteProcessor?: {
      disabled?: boolean;
      processIntervalMs?: number;
      maxRetries?: number;
      baseRetryDelayMs?: number;
      initialEnqueueDelayMs?: number;
    };
  };
}
```

- repo: A storage adapter that satisfies the `CocoRepositories` interface. See [Storage Adapters](./storage-adapters.md) for more information
- seedGetter: A asynchronous function that returns a BIP-39 conforming seed as `Uint8Array`. See [BIP-39](./bip39.md) for more information.
- logger (optional): An implementation of the Logger interface that Coco will use to log
- websocketFactory (optional): A factory function that should return a `WebsocketLike` instance that will be used by Coco to establish websocket connections. If the global `WebSocket` is not present and `websocketFactory` is undefined coco will fallback to polling.
- plugins (optional): An array of `CocoPlugins` that can be used to inject functionality in Coco. See [Plugins](./plugins.md) for more information.
- watchers (optiona): Can be used to disable or configure the available watchers. See [Watchers & Processors](./watchers-processors.md) for more informations
- processors (optiona): Can be used to disable or configure the available processors. See [Watchers & Processors](./watchers-processors.md) for more informations
