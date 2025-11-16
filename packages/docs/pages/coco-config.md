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

- repo: A storage adapter that satisfies the `Repositories` interface. See [Storage Adapters](./storage-adapters.md) for more information
- seedGetter: An asynchronous function that returns a BIP-39 conforming seed as `Uint8Array`. See [BIP-39](./bip39.md) for more information.
- logger (optional): An implementation of the Logger interface that Coco will use to log
- webSocketFactory (optional): A factory function that should return a `WebSocketLike` instance that will be used by Coco to establish websocket connections. If the global `WebSocket` is not present and `webSocketFactory` is undefined coco will fallback to polling.
- plugins (optional): An array of `Plugin` that can be used to inject functionality in Coco. See [Plugins](./plugins.md) for more information.
- watchers (optional): Can be used to disable or configure the available watchers. See [Watchers & Processors](./watchers-processors.md) for more information
- processors (optional): Can be used to disable or configure the available processors. See [Watchers & Processors](./watchers-processors.md) for more information
