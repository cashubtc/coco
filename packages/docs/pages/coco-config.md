# Configuring Coco

Coco can be configured using a configuration object `CocoConfig`

```ts
import type { Logger, OutputDataCreator, WebSocketFactory } from '@cashu/coco-core';
import type { Repositories } from '@cashu/coco-core/adapter';
import type { Plugin } from '@cashu/coco-core/plugin';

export interface CocoConfig {
  repo: Repositories;
  seedGetter: () => Promise<Uint8Array>;
  logger?: Logger;
  webSocketFactory?: WebSocketFactory;
  plugins?: Plugin[];
  outputDataCreator?: OutputDataCreator;
  watchers?: {
    mintOperationWatcher?: {
      disabled?: boolean;
      watchExistingPendingOnStart?: boolean;
      watchExistingPendingQuotesOnStart?: boolean;
    };
    proofStateWatcher?: {
      disabled?: boolean;
      watchExistingInflightOnStart?: boolean;
    };
    meltQuoteWatcher?: {
      disabled?: boolean;
      watchExistingPendingQuotesOnStart?: boolean;
    };
  };
  processors?: {
    mintOperationProcessor?: {
      disabled?: boolean;
      processIntervalMs?: number;
      maxRetries?: number;
      baseRetryDelayMs?: number;
      initialEnqueueDelayMs?: number;
      autoClaimMintQuotes?: boolean;
    };
    meltSettlementProcessor?: {
      disabled?: boolean;
      initializeExistingPendingOperationsOnStart?: boolean;
    };
  };
}
```

- repo: A storage adapter that satisfies the `Repositories` interface. See [Storage Adapters](./storage-adapters.md) for more information
- seedGetter: An asynchronous function that returns a BIP-39 conforming seed as `Uint8Array`. See [BIP-39](./bip39.md) for more information.
- logger (optional): An implementation of the Logger interface that Coco will use to log
- webSocketFactory (optional): A factory function that should return a `WebSocketLike` instance that will be used by Coco to establish websocket connections. If the global `WebSocket` is not present and `webSocketFactory` is undefined coco will fallback to polling.
- plugins (optional): An array of `Plugin` that can be used to inject functionality in Coco. See [Plugins](./plugins.md) for more information.
- outputDataCreator (optional): A session-wide strategy for constructing Cashu output material. See [Custom output construction](#custom-output-construction).
- watchers (optional): Can be used to disable or configure the available watchers. See [Watchers & Processors](./watchers-processors.md) for more information
- processors (optional): Can be used to disable or configure the available processors. See [Watchers & Processors](./watchers-processors.md) for more information

## Custom output construction

Pass an `OutputDataCreator` to replace Cashu output construction for the lifetime of a Coco Session:

```ts
import { initializeCoco, type OutputDataCreator } from '@cashu/coco-core';

declare function createRuntimeOutputDataCreator(): OutputDataCreator;

const outputDataCreator = createRuntimeOutputDataCreator();

const coco = await initializeCoco({ repo, seedGetter, outputDataCreator });
```

The same creator object is used by every mint-and-unit-scoped Wallet Instance and by Coco's mint,
send, receive, melt, Restore, and sweep output paths. If it throws, the requesting operation fails;
Coco does not fall back to built-in construction. Omitting it preserves the standard `cashu-ts`
behavior.

Creator results must be `OutputDataLike`: they must provide a standard blinded message, blinding
factor, secret, optional `ephemeralE`, and `toProof()` method. Coco persists only those standard
fields. When a later operation reads persisted output data, Coco reconstructs the standard
`cashu-ts` `OutputData` and uses its standard `toProof()` implementation; custom object identity or
a custom `toProof()` implementation is not preserved across serialization.
