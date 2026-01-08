# Plugins

Coco's plugin system allows you to extend the wallet's functionality by hooking into its lifecycle and registering custom APIs.

## Basic Plugin Structure

A plugin is an object that implements the `Plugin` interface:

```ts
import type { Plugin } from '@coco/core';

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
import { initializeCoco } from '@coco/core';

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

Plugins can request access to internal services by declaring them in the `required` array. The following services are available:

| Service | Description |
|---------|-------------|
| `mintService` | Manage mints (add, update, trust/untrust) |
| `walletService` | Low-level wallet operations |
| `proofService` | Manage proofs (save, delete, query) |
| `keyRingService` | P2PK key management |
| `seedService` | Access the wallet seed |
| `walletRestoreService` | Restore wallet from seed |
| `counterService` | Keyset counter management |
| `mintQuoteService` | Mint quote operations |
| `meltQuoteService` | Melt quote operations |
| `historyService` | Transaction history |
| `transactionService` | Send/receive transactions |
| `sendOperationService` | Send operation lifecycle |
| `subscriptions` | WebSocket subscription manager |
| `eventBus` | Event pub/sub system |
| `logger` | Logging interface |

## Plugin Extensions

Plugins can register custom APIs that become accessible via `manager.ext`. This allows plugins to expose their own public interface to consumers.

### Registering an Extension

Use `ctx.registerExtension(key, api)` in your plugin's `onInit` or `onReady` hook:

```ts
class MyPluginApi {
  constructor(private eventBus: EventBus) {}
  
  doSomething() {
    this.eventBus.emit('my-plugin:action', { foo: 'bar' });
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
manager.ext.myPlugin.doSomething();
const result = await manager.ext.myPlugin.fetchData();
```

### TypeScript Support

For full TypeScript autocomplete and type safety, plugin authors should augment the `PluginExtensions` interface using module augmentation:

```ts
// my-plugin/index.ts
import type { Plugin, PluginExtensions } from '@coco/core';

// Define your API class
export class MyPluginApi {
  constructor(private eventBus: EventBus) {}
  doSomething(): void { /* ... */ }
  async fetchData(): Promise<{ data: string }> { /* ... */ }
}

// Augment PluginExtensions for type safety
declare module '@coco/core' {
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
import { initializeCoco } from '@coco/core';
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

When using `initializeCoco()`:

1. Manager is constructed with all services
2. `manager.initPlugins()` is awaited:
   - All plugins' `onInit` hooks run in registration order
   - All plugins' `onReady` hooks run in registration order
3. Watchers and processors are enabled
4. Manager is returned, fully initialized

This ensures that `manager.ext` contains all registered extensions before the manager is returned to the caller.

## Direct Manager Instantiation

If you instantiate `Manager` directly instead of using `initializeCoco()`, you must call `initPlugins()` manually:

```ts
const manager = new Manager(
  repositories,
  seedGetter,
  logger,
  webSocketFactory,
  [myPlugin],
);

// Required for plugins to initialize and extensions to be available
await manager.initPlugins();

// Now extensions are available
manager.ext.myPlugin.doSomething();
```

## Error Handling

- Errors in `onInit` and `onReady` are logged but do not prevent other plugins from initializing
- `ExtensionRegistrationError` (duplicate keys) will propagate and fail initialization
- Errors in `onDispose` are logged but do not prevent other plugins from disposing
