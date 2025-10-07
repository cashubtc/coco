# Coco in NodeJS

In this example we will setup a coco wallet in a long-running NodeJS process (like a web server).

## Dependencies

After setting up your node project we need to install the required dependencies.

- coco-cashu-core: Our core module
- coco-cashu-sqlite3: Our sqlite3 storage adapter
- sqlite3: A sqlite driver / client for node
- ws & @types/ws: A websocket implementation for node
- @scure/bip39: A set of utilities to work with BIP39 mnemonics

## Setup

Once all dependencies are installed we need to prepare our project so that we can use coco.

### Seed Getter

Coco requires a BIP39 conforming seed to work. In our example we will read a BIP39 mnemonic from a local file and convert it into the `Uint8Array` for coco to read.

```ts
// seedgetter.ts
import { readFile } from 'node:fs/promises';
import { mnemonicToSeed } from '@scure/bip39';

export function cachedSeedGetter() {
  let seed: Uint8Array | undefined = undefined;
  async function seedGetter() {
    if (seed) {
      return seed;
    }
    const file = await readFile('./mnemonic.txt', 'utf8');
    seed = await mnemonicToSeed(file);
    return seed;
  }
  return seedGetter;
}
```

### Persistence

We are going to use sqlite3 to persist our wallet data. Coco expects a repository implementation when instantiating. The `coco-cashu-sqlite3` package helps us bridge sqlite3 to coco

```ts
// repo.ts
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';

const db = new Database('./coco.db');
export const repo = new SqliteRepositories({ database: db });
```

### Websockets

As node does not offer a native Websocket implementation we will provide one to Coco using the `ws` package

```ts
// websocket.ts
import { WebSocket } from 'ws';
import { WebSocketFactory } from 'coco-cashu-core';

export const websocketFactory: WebsocketFactory = (url: string) => new Websocket(url);
```

## Initialize Coco

Now that we have all the parts prepared we can bring them together and instantiate coco

```ts
import { initializeCoco } from 'coco-cashu-core';
import { repo } from './repo.ts';
import { websocketFactory } from './websocket.ts';
import { cachedSeedGetter } from './seedgetter.ts';

export const coco = await initializeCoco({
  repo: repo,
  seedGetter: cachedSeedGetter(),
  websocketFactory: websocketFactory,
});
```

## Use Coco

Now that we have instantiated and exported an active coco manager class, we can use it in our modules

```ts
import { coco } from './coco.ts';

async function apiBalanceController(res, req, next) {
  const balance = await coco.wallet.getBalance();
  res.json({ balance });
}
```
