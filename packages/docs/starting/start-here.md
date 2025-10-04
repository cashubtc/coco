# Start using Coco

Coco is a TypeScript library that simplifies the development of Cashu applications. It provides a unified, platform-agnostic API for creating Cashu wallets, allowing you to focus on building across browsers, Node.js, and React Native.

## Initialization

To get started all you got to do is create a Coco `Manager` instance. This instance will be your entry-point to your Coco Cashu wallet.

```ts
import { initializeCoco } from 'coco-cashu-core';

const coco = await initializeCoco({ seedGetter });

// After initialization you can start to you your coco wallet
const balance = await coco.wallet.getBalance();
```

## BIP-39 Seed

In order to work properly coco requires you to supply a BIP39 conforming seed. Coco will never persist that seed, so you need to supply it via a `seedGetter` function. This function is expected to be passed when instantiating coco and will be called automatically when coco needs the key to derive new secrets from it

```ts
import { initializeCoco } from 'coco-cashu-core';

async function seedGetter(): Uint8Array {
  // add your implementation here
  // e.g. reading a mnemonic from SecureStorage and converting it to a BIP-39 seed
}

const coco = await initializeCoco({ seedGetter });

// Coco will now use the seed to derive deterministic secrets when required.
await coco.wallet.receive('cashuB...');
```

## Setting up persistence

By default coco uses an in-memory store that will be lost as soon as the process finishes. As that is undesirable in most cases, coco comes with a range of [Storage Adapters](../pages/storage-adapters.md) to attach it to a database of your choice.

```ts
import { initializeCoco } from 'coco-cashu-core';
import { IndexedDbRespositories } from 'coco-cashu-indexeddb';

const repo = new IndexedDbRepositories({ name: 'coco' });
const coco = await initializeCoco({
  repo,
});

// Whenever coco now saves data it will use the provided database
await coco.wallet.receive('cashuB...');
```
