# Start using Coco

Coco is a TypeScript library that simplifies the development of Cashu applications. It provides a unified, platform-agnostic API for creating Cashu wallets, allowing you to focus on building across browsers, Node.js, and React Native.

If you tested the old `coco-cashu-*` alpha packages, read
[Migrating from Alpha](./migrating-from-alpha.md) before wiring the current
`@cashu/*` packages into your app.

## Initialization

To get started all you got to do is create a Coco `Manager` instance. This instance will be your entry-point to your Coco Cashu wallet.

```ts
import { initializeCoco } from '@cashu/coco-core';

const coco = await initializeCoco({ storage, seedGetter });

// After initialization you can start to use your coco wallet
const balances = await coco.wallet.balances.byMint();
const total = await coco.wallet.balances.total();
```

For lifecycle-oriented operation flows, use `coco.ops.send`, `coco.ops.receive`,
and `coco.ops.melt`.

## Core import paths

Most applications only need the package root:

```ts
import { initializeCoco, Amount, type Manager } from '@cashu/coco-core';
```

Use dedicated subpaths when you build lower-level extensions:

```ts
// Independent SQLite runtime bindings
import { createSqliteStorage, type SqlDatabase } from '@cashu/coco-sql-storage';

// Plugin authors
import type { Plugin, PluginExtensions } from '@cashu/coco-core/plugin';
```

The root API is the stable application surface. The SQL package supplies the supported driver contract,
and the plugin subpath supports extension authors. Repository implementations are internal.

## BIP-39 Seed

In order to work properly coco requires you to supply a BIP39 conforming seed. Coco will never persist that seed, so you need to supply it via a `seedGetter` function. This function is expected to be passed when instantiating coco and will be called automatically when coco needs the key to derive new secrets from it

```ts
import { initializeCoco } from '@cashu/coco-core';

async function seedGetter(): Uint8Array {
  // add your implementation here
  // e.g. reading a mnemonic from SecureStorage and converting it to a BIP-39 seed
}

const coco = await initializeCoco({ storage, seedGetter });

// Before receiving tokens, you need to add and trust the mint
await coco.mint.addMint('https://mint.url', { trusted: true });

// Coco will now use the seed to derive deterministic secrets when required.
await coco.wallet.receive('cashuB...');
```

> **Note:** Wallet operations like receiving tokens require the mint to be explicitly trusted. See [Adding a Mint](./adding-mints.md) for more details.

## Setting up persistence

Choose storage explicitly. `createMemoryStorage()` provides transient storage for tests and examples.
For persistent Wallet data, choose from the [Storage Adapters](../pages/storage-adapters.md) to attach it to a database of your choice.

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createIndexedDbStorage } from '@cashu/coco-indexeddb';

const storage = createIndexedDbStorage({ name: 'coco' });
const coco = await initializeCoco({
  storage,
  seedGetter,
});

// Add and trust a mint before performing wallet operations
await coco.mint.addMint('https://mint.url', { trusted: true });

// Whenever coco now saves data it will use the provided database
await coco.wallet.receive('cashuB...');
```

## Configuring Coco

Coco can be configured in various ways to fit different environments. When calling `initializeCoco` with only the required options sane defaults will be applies. When you want to further configure Coco check out [Coco Config](../pages/coco-config.md).
