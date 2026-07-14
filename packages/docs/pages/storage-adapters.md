# Storage Adapters

Coco is built in a platform agnostic way. As we can not assume anything about the presence of a certain storage API (e.g. IndexedDB), coco exposes a storage interface that needs to be satisfied when instantiating.

```ts
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite';

const repo = new SqliteRepositories({ database: db }); // Implements the Repositories interface
await repo.init(); // Ensures schema and applies migrations
const coco = await initializeCoco({
  repo, // <-- pass the storage implementation
  seedGetter,
  // other params
});
```

Some storage implementations are maintained as part of the cashubtc/coco repository, but technically you can use any class that implements the `Repositories` interface.

App code imports `initializeCoco` and other wallet-facing symbols from
`@cashu/coco-core`. Adapter implementations and adapter contract tests should
import repository contracts and serialization helpers from the adapter subpath:

```ts
import { type Repositories, serializeAmount } from '@cashu/coco-core/adapter';
```

The adapter subpath is the stable public surface for persistence authors.
Concrete core services, operation service classes, handler providers, transport
internals, and individual memory repository classes are not part of the
app-facing root API.

## Security

Coco's built-in storage adapters do not encrypt wallet data at rest. Stored data can include
bearer proofs, proof secrets, P2PK private keys, and NUT-20 mint-quote private keys. Treat the
underlying database and any associated journals, write-ahead logs, and backups as sensitive.

The embedding application is responsible for storage protection. Applications that require
encryption at rest should use an encrypted database, encrypted filesystem or platform storage, or
a custom `Repositories` implementation that provides the required protection. Ensure that the
chosen protection also covers database journals and backups.

## SQLite adapter public API

The SQLite adapter packages share the same public shape. Import
`SqliteRepositories` from the package that matches your runtime, open the
database with that runtime's SQLite driver, and pass the already-opened database
instance through the `database` option.

Your application owns the database lifecycle. The Coco adapter creates schema
and runs migrations when you call `repo.init()`, but it does not open or close
the underlying database.

The public SQLite adapter packages expose the repository aggregate and its
option type. Migration helpers, database wrapper classes, and individual
repository classes are internal implementation details.

## @cashu/coco-indexeddb

Implements Repositories using the IndexedDB Browser API.

Installation:

```sh
npm i @cashu/coco-indexeddb
```

Usage:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';

const repo = new IndexedDbRepositories({ name: 'your-db-name' });
const coco = await initializeCoco({
  repo,
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
import { SqliteRepositories } from '@cashu/coco-expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

// Open the Expo SQLite database in your application
const db = await openDatabaseAsync('coco-demo.db');
// Pass the already-opened database to the storage implementation
const repo = new SqliteRepositories({ database: db });
const coco = await initializeCoco({
  repo,
  seedGetter,
});
```

`ExpoSqliteRepositories` and `ExpoSqliteRepositoriesOptions` are available as
soft-migration aliases for `SqliteRepositories` and
`SqliteRepositoriesOptions`.

## @cashu/coco-sqlite

Installation:

```sh
npm i @cashu/coco-sqlite
npm i better-sqlite3
```

Usage:

```ts
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite';
import Database from 'better-sqlite3';

// Open the better-sqlite3 database in your application
const db = new Database('./test.db');
// Pass the already-opened database to the storage implementation
const repo = new SqliteRepositories({ database: db });
const coco = await initializeCoco({
  repo,
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
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';

// Open the bun:sqlite database in your application
const db = new Database('./test.db');
// Pass the already-opened database to the storage implementation
const repo = new SqliteRepositories({ database: db });
const coco = await initializeCoco({
  repo,
  seedGetter,
});
```

**Note:** This adapter is specifically designed for Bun runtime environments. For
Node.js environments, use `@cashu/coco-sqlite` instead.
