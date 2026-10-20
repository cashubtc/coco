# Storage Adapters

Coco does not assume that a particular storage API is available. Choose the built-in adapter for
your runtime, initialize it, and pass it to `initializeCoco`.

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createSqliteStorage } from '@cashu/coco-sqlite';

const storage = createSqliteStorage({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
  // other params
});
```

## Security

Coco's built-in storage adapters do not encrypt wallet data at rest. Stored data can include
bearer proofs, proof secrets, P2PK private keys, and NUT-20 mint-quote private keys. Treat the
underlying database and any associated journals, write-ahead logs, and backups as sensitive.

The embedding application is responsible for storage protection. Applications that require
encryption at rest should use an encrypted database, encrypted filesystem or platform storage, or
a storage implementation that provides the required protection. Ensure that the chosen protection
also covers database journals and backups.

Back up and restore keypairs and key-derivation high-water metadata together. A full database
deletion intentionally starts a new local allocation namespace. Restoring a historical snapshot can
reproduce deterministic keys created after that snapshot when the same Wallet Seed is reused;
applications must avoid exposing post-snapshot quote keys or rotate to a new seed/allocation
namespace.

## Storage contract

Factories return opaque handles with `init(): Promise<void>`. `initializeCoco` calls it automatically.
The supported advanced path is `await storage.init(); new Manager(storage, seedGetter)`; construction
performs wiring only. See [the v3 migration guide](../starting/migrating-from-v2.md).

SQLite factories borrow caller-opened connections; callers close them after all work completes.
IndexedDB owns its connection and supplies `storage.close()`, which releases it without deleting data.
`Manager.dispose()` does not close storage. Successful initialization means opening and migrations
have completed, including IndexedDB opening failures being reported at initialization time.

The SQL runtime packages accept `{ database, mintSwap? }`. Repository methods, classes and schema
helpers are internal. Match release versions across Coco-owned storage packages and core. Internal
entry points have no compatibility or versioning guarantees, even across patch/minor releases.

Independent SQLite runtime authors can use `@cashu/coco-sql-storage` and its `/test` conformance suite.
See [the driver contract](https://github.com/cashubtc/coco/blob/master/packages/sql-storage/README.md).
This does not imply PostgreSQL support or support for runtimes lacking interactive atomic transactions.

## @cashu/coco-indexeddb

Creates opaque storage using the IndexedDB Browser API.

Installation:

```sh
npm i @cashu/coco-indexeddb
```

Usage:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createIndexedDbStorage } from '@cashu/coco-indexeddb';

const storage = createIndexedDbStorage({ name: 'your-db-name' });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## @cashu/coco-expo-sqlite

Installation:

```sh
npm i @cashu/coco-expo-sqlite
# @cashu/coco-expo-sqlite expects an Expo SQLite client to be passed
npx expo install expo-sqlite
```

Usage:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createSqliteStorage } from '@cashu/coco-expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

// Open the Expo SQLite database in your application
const db = await openDatabaseAsync('coco-demo.db');
// Pass the already-opened database to the storage implementation
const storage = createSqliteStorage({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## @cashu/coco-sqlite

Installation:

```sh
npm i @cashu/coco-sqlite
npm i better-sqlite3
```

Usage:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createSqliteStorage } from '@cashu/coco-sqlite';
import Database from 'better-sqlite3';

// Open the better-sqlite3 database in your application
const db = new Database('./test.db');
// Pass the already-opened database to the storage implementation
const storage = createSqliteStorage({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## @cashu/coco-sqlite-bun

SQLite adapter for Bun runtime using Bun's built-in `bun:sqlite` module.

Installation:

```sh
npm i @cashu/coco-sqlite-bun
```

Usage:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createSqliteStorage } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';

// Open the bun:sqlite database in your application
const db = new Database('./test.db');
// Pass the already-opened database to the storage implementation
const storage = createSqliteStorage({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

**Note:** This adapter is specifically designed for Bun runtime environments. For
Node.js environments, use `@cashu/coco-sqlite` instead.
