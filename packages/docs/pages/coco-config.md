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
    mintSwapOperationProcessor?: {
      disabled?: boolean;
      processIntervalMs?: number;
      sweepIntervalMs?: number;
      batchSize?: number;
    };
    mintOperationProcessor?: {
      disabled?: boolean;
      processIntervalMs?: number;
      maxRetries?: number;
      baseRetryDelayMs?: number;
      initialEnqueueDelayMs?: number;
      autoClaimMintQuotes?: boolean;
      batchMintQuotes?: boolean;
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
- outputDataCreator (optional): A session-wide strategy used only to construct Cashu output material. See [Custom output construction](#custom-output-construction).
- watchers (optional): Can be used to disable or configure the available watchers. See [Watchers & Processors](./watchers-processors.md) for more information
- processors (optional): Can be used to disable or configure the available processors. See [Watchers & Processors](./watchers-processors.md) for more information

The Mint Swap API is always available. `processors.mintSwapOperationProcessor` controls automatic
recovery and defaults to enabled, including on restart with unfinished swaps. Setting `disabled: true`
skips automatic parent startup/resume passes and timers; all explicit commands remain available,
including preparation, execution, `ops.mintSwap.refresh(id)` and `ops.mintSwap.recovery.run()`. Generic Mint/Melt
recovery, ordinary processors and automatic quote claiming leave children of active Mint Swaps to
the parent, so disabling this processor also pauses them; see
[Mint Swap Operations](https://github.com/cashubtc/coco/blob/master/TRANSACTION_DESIGN.md#mint-swap-operations). Scan defaults are `processIntervalMs: 1000`,
`sweepIntervalMs: 30000`, and `batchSize: 25`; durable retry deadlines remain authoritative.

`processors.mintOperationProcessor.batchMintQuotes` defaults to `true`. Automatic claiming then
groups claimable quotes by mint, method and unit, both in the startup sweep and over one processing
turn (`processIntervalMs`, default `3000`) of quote updates, and claims each group of two or more
within the mint's NUT-29 batch limit as one
[Batch Mint Operation](./mint-operations.md#batch-mint-operations-coco-ops-mint-batch). A lone
quote, a method the mint does not advertise for NUT-29, a quote with a nonterminal mint operation
and a quote coordinated by an active Mint Swap keep a standalone mint operation. When the mint
rejects a batch, its still-claimable quotes are claimed again as standalone mint operations. If the
batch endpoint is unsupported, answers with a malformed response or rejects with `11017` (batch too
large), automatic claiming uses standalone mint operations for that mint and method for the rest of
the Coco Session; network, authentication, rate-limit and server failures do not change this.
Batched quotes settle through `batch-mint-op:*` events instead of `mint-op:*`, and each keeps its own
history entry. Set `batchMintQuotes: false` to claim one standalone mint operation per quote;
`ops.mint.batch` stays available either way.

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

`outputDataCreator` is a construction hook, not a persistent proof-conversion hook. It does not
replace output reconstruction or guarantee that a custom `toProof()` implementation will be used
later.

Creator results must be `OutputDataLike`: they must provide a standard blinded message, blinding
factor, secret, optional `ephemeralE`, and `toProof()` method. Coco persists only those standard
fields. When a later operation reads persisted output data, Coco reconstructs the standard
`cashu-ts` `OutputData`, so its built-in `toProof()` implementation may be used instead. Custom
object identity and a custom `toProof()` implementation are not preserved across serialization.
