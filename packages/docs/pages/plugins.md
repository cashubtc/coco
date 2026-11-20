# Plugins

Coco's plugin system allows you to extend the wallet's functionality by hooking into its lifecycle and registering custom APIs.

Plugin authors should import plugin lifecycle types, extension augmentation
types, service keys, and plugin errors from `@cashu/coco-core/plugin`.
Applications still import `initializeCoco` and manager-facing symbols from the
package root.

## Basic Plugin Structure

A plugin is an object that implements the `Plugin` interface:

```ts
import type { Plugin } from '@cashu/coco-core/plugin';

const myPlugin: Plugin<['eventBus', 'logger']> = {
  name: 'my-plugin',
  required: ['eventBus', 'logger'],
  onInit(ctx) {
    // Called when the plugin system initializes
    ctx.services.logger.info('Plugin initialized!');

    // Subscribe to events
    const unsubscribe = ctx.services.eventBus.on('proofs:saved', (payload) => {
      ctx.services.logger.info('Proofs saved', payload);
    });

    // Return cleanup function (optional)
    return unsubscribe;
  },
  onReady(ctx) {
    // Called after all plugins have been initialized
    ctx.services.logger.info('Plugin ready!');
  },
  onDispose() {
    // Called when the manager is disposed
  },
};
```

## Registering Plugins

Pass plugins to `initializeCoco()` via the `plugins` config option:

```ts
import { initializeCoco } from '@cashu/coco-core';

const manager = await initializeCoco({
  repo,
  seedGetter,
  plugins: [myPlugin],
});
```

Or register them at runtime using `manager.use()`:

```ts
manager.use(myPlugin);
```

## Available Services

Plugins can request supported service capabilities by declaring them in the `required` array. The following service keys are available:

These service keys are the supported plugin service surface. Plugins should import
`ServiceKey`, `ServiceMap`, `Plugin`, `PluginContext`, and `PluginExtensions` from
`@cashu/coco-core/plugin` instead of the package root. `PluginHost` is runtime
implementation wiring and is not needed to author extensions.

| Service                        | Description                                 |
| ------------------------------ | ------------------------------------------- |
| `mintService`                  | Manage mints (add, update, trust/untrust)   |
| `walletService`                | Low-level wallet operations                 |
| `keyRingService`               | P2PK key management                         |
| `seedService`                  | Access the wallet seed                      |
| `walletRestoreService`         | Restore wallet from seed                    |
| `tokenService`                 | Token decoding and encoding helpers         |
| `historyService`               | Transaction history                         |
| `sendOperationService`         | Send operation lifecycle                    |
| `receiveOperationService`      | Receive operation lifecycle                 |
| `meltOperationService`         | Melt operation lifecycle                    |
| `mintOperationService`         | Mint operation lifecycle                    |
| `quotes`                       | Canonical quote create/import/lookup API    |
| `balances`                     | Read-only wallet balances                   |
| `paymentRequestService`        | Payment request helpers                     |
| `paymentRequestReceiveService` | Payment request receive operation lifecycle |
| `subscriptions`                | WebSocket subscription manager              |
| `eventBus`                     | Event pub/sub system                        |
| `logger`                       | Logging interface                           |

Plugins that sync externally created mint quotes can request `quotes` and use
the same canonical quote API available on the manager:

```ts
import type { Plugin } from '@cashu/coco-core/plugin';

const externalQuotePlugin: Plugin<['quotes']> = {
  name: 'external-quote-plugin',
  required: ['quotes'],
  onReady: async ({ services }) => {
    await services.quotes.mint.import({
      mintUrl,
      method: 'bolt11',
      quote,
    });
  },
};
```

Plugins that need balances can request `balances`. It is the same read-only API as
`manager.wallet.balances`:

```ts
import type { Plugin } from '@cashu/coco-core/plugin';

const balancePlugin: Plugin<['balances']> = {
  name: 'balance-plugin',
  required: ['balances'],
  onReady: async ({ services }) => {
    const byMint = await services.balances.byMint();
    const total = await services.balances.total({ units: ['sat'] });
  },
};
```

Plugins get no direct proof or counter authority. Plugins move value through operations, which
own their proof changes and commit them transactionally.

## Migrating from `proofService` and `counterService`

The `proofService` and `counterService` plugin keys, and the `ProofService` and `CounterService`
classes, have been removed. Migrate as follows:

- **Moving value**: use the operation services instead of writing proofs. Send with
  `sendOperationService`, receive with `receiveOperationService`, mint with
  `mintOperationService`, and melt with `meltOperationService`. They select, reserve, create
  outputs and save proofs for you.
- **Balances**: request `balances` instead of `proofService.getBalances*()`. For example,
  `getBalancesByMint()` becomes `balances.byMint()` and `getBalanceTotal()` becomes
  `balances.total()`. For trusted mints only, pass `{ trustedOnly: true }` and read each
  mint's `total` or `spendable` snapshot field.
- **Counters**: there is no replacement. Output Counters advance only inside operations and
  Restore, so plugins can't read, increment or overwrite them.

Plugins can no longer list raw proofs. Open an issue if your plugin needs that.

## Migrating history operation lookups

`historyService.getOperationIdFromHistoryEntry()` has been removed. It was a send-only
lookup that threw when an entry was missing, was another history type, or had no operation ID.
Plugins already declaring `historyService` can read the entry directly:

```ts
const entry = await ctx.services.historyService.getHistoryEntryById(historyId);
const operationId = entry?.operationId?.trim() || null;
```

This accepts every history type and returns `null` for missing entries or absent/blank
operation IDs. If your plugin depends on the former send-only errors, retain those checks:

```ts
const entry = await ctx.services.historyService.getHistoryEntryById(historyId);
if (!entry) throw new Error(`History entry ${historyId} not found`);
if (entry.type !== 'send') throw new Error(`History entry ${historyId} is not a send entry`);
if (!entry.operationId) {
  throw new Error(`History entry ${historyId} is not backed by an operation`);
}
const operationId = entry.operationId;
```

Applications can continue to use `manager.history.getOperationIdForHistoryEntry(historyId)`.
That lookup accepts every history type, trims operation IDs, and returns `null` for
missing entries or absent/blank IDs.

`HistoryEntry` now includes `type: 'mint-swap'`; exhaustive plugin switches must add that case.
History lists expose one grouped parent row and suppress its exact Mint/Melt children, while
`getHistoryEntryById()` still permits direct parent and child lookup. Treat `history:updated` as an
invalidation and reread the relevant page rather than splicing its entry into a sorted list.

## Plugin Extensions

Plugins can register custom APIs that become accessible via `manager.ext`. This allows plugins to expose their own public interface to consumers.

### Registering an Extension

Use `ctx.registerExtension(key, api)` in your plugin's `onInit` or `onReady` hook:

```ts
import type { Plugin, PluginEventBus } from '@cashu/coco-core/plugin';

class MyPluginApi {
  constructor(private eventBus: PluginEventBus) {}

  onHistoryUpdated(handler: () => void): () => void {
    return this.eventBus.on('history:updated', handler);
  }

  async fetchData() {
    // Custom plugin logic
    return { data: 'example' };
  }
}

const myPlugin: Plugin<['eventBus']> = {
  name: 'my-plugin',
  required: ['eventBus'],
  onInit(ctx) {
    const api = new MyPluginApi(ctx.services.eventBus);
    ctx.registerExtension('myPlugin', api);
  },
};
```

### Using Extensions

After initialization, access the extension via `manager.ext`:

```ts
const manager = await initializeCoco({
  repo,
  seedGetter,
  plugins: [myPlugin],
});

// Access the plugin's API
const unsubscribe = manager.ext.myPlugin.onHistoryUpdated(() => {});
const result = await manager.ext.myPlugin.fetchData();
```

### TypeScript Support

For full TypeScript autocomplete and type safety, plugin authors should augment the `PluginExtensions` interface using module augmentation:

```ts
// my-plugin/index.ts
import type { Plugin, PluginEventBus, PluginExtensions } from '@cashu/coco-core/plugin';

// Define your API class
export class MyPluginApi {
  constructor(private eventBus: PluginEventBus) {}
  onHistoryUpdated(handler: () => void): () => void {
    return this.eventBus.on('history:updated', handler);
  }
  async fetchData(): Promise<{ data: string }> {
    /* ... */
  }
}

// Augment PluginExtensions for type safety
declare module '@cashu/coco-core/plugin' {
  interface PluginExtensions {
    myPlugin: MyPluginApi;
  }
}

// Export the plugin
export const myPlugin: Plugin<['eventBus']> = {
  name: 'my-plugin',
  required: ['eventBus'],
  onInit(ctx) {
    ctx.registerExtension('myPlugin', new MyPluginApi(ctx.services.eventBus));
  },
};
```

When consumers import your plugin, they automatically get full type support:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { myPlugin } from 'my-plugin'; // Type augmentation is included

const manager = await initializeCoco({
  plugins: [myPlugin],
  // ...
});

// Full autocomplete and type checking!
manager.ext.myPlugin.doSomething();
const result = await manager.ext.myPlugin.fetchData();
//    ^? Promise<{ data: string }>
```

### Extension Conflicts

Each extension key must be unique. If two plugins attempt to register the same key, an `ExtensionRegistrationError` will be thrown during initialization:

```ts
// This will throw an error
const pluginA: Plugin<['logger']> = {
  name: 'plugin-a',
  required: ['logger'],
  onInit(ctx) {
    ctx.registerExtension('shared', { from: 'A' });
  },
};

const pluginB: Plugin<['logger']> = {
  name: 'plugin-b',
  required: ['logger'],
  onInit(ctx) {
    ctx.registerExtension('shared', { from: 'B' }); // Throws!
  },
};
```

## Lifecycle Hooks

### `onInit(ctx)`

Called when the plugin system initializes. This is where you should:

- Set up event listeners
- Register extensions
- Initialize plugin state

The context provides access to requested services and the `registerExtension` method.

Return a cleanup function to be called during disposal (optional).

### `onReady(ctx)`

Called after all plugins have completed their `onInit` phase. Use this for:

- Logic that depends on other plugins being initialized
- Registering extensions that depend on other extensions

Return a cleanup function to be called during disposal (optional).

### `onDispose()`

Called when `manager.dispose()` is invoked. Use this for:

- Cleaning up resources
- Closing connections
- Flushing data

## Plugin Initialization Order

`initializeCoco()` and `Manager.create()` start a Coco Session in this order:

1. Manager is constructed with all services
2. Plugins are initialized:
   - All plugins' `onInit` hooks run in registration order
   - All plugins' `onReady` hooks run in registration order
3. Selected watchers and processors start, and startup Operation Recovery runs
4. Manager is returned, fully initialized

This ensures that `manager.ext` contains all registered extensions before the manager is returned to
the caller. Plugin hooks also run before any background work, so `onInit` can subscribe to events
emitted during startup.

`Manager` cannot be constructed directly. Pass plugins through `initializeCoco({ plugins })`, or
register them later with `manager.use(plugin)`.

## Error Handling

- Errors in `onInit` and `onReady` are logged but do not prevent other plugins from initializing
- `ExtensionRegistrationError` (duplicate keys) will propagate and fail initialization
- Errors in `onDispose` are logged but do not prevent other plugins from disposing
