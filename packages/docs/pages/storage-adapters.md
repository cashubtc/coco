# Storage Adapters

Coco is built in a platform agnostic way. As we can not assume anything about the presence of a certain storage API (e.g. IndexedDB), coco exposes a storage interface that needs to be satisfied when instantiating.

```ts
const storage = new ExpoSqliteRepositories({ database: db });
await storage.init(); // Ensures schema and applies migrations
const coco = await initializeCoco({
  storage,
  seedGetter,
  // other params
});
```

Some storage implementations are maintained as part of the cashubtc/coco repository, but technically you can use any class that implements the `Repositories` interface.

## coco-cashu-indexeddb

Implements Repositories using the IndexedDB Browser API.

Installation:

```sh
npm i coco-cashu-indexeddb
```

Usage:

```ts
import { initializeCoco } from 'coco-cashu-core';
import { IndexedDbRepositories } from 'coco-cashu-indexeddb';

const storage = new IndexedDbRepositories({ name: 'your-db-name' });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## coco-cashu-expo-sqlite

Installation:

```sh
npm i coco-cashu-expo-sqlite
# coco-cashu-expo-sqlite expects an Expo SQLite client to be passed
npx expo install expo-sqlite
```

Usage:

```ts
import { initializeCoco } from 'coco-cashu-core';
import { ExpoSqliteRepositories } from 'coco-cashu-expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

// First we create an expo-sqlite client
const db = await openDatabaseAsync('coco-demo.db');
// Then we pass it to our storage implementation
const storage = new ExpoSqliteRepositories({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## coco-cashu-sqlite3

Installation:

```sh
npm i coco-cashu-sqlite3
npm i sqlite3
```

Usage:

```ts
import { initializeCoco } from 'coco-cashu-core';
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';

// First we create a sqlite3 client
const db = new Database('./test.db');
// Then we pass it to our storage implementation
const storage = new SqliteRepositories({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## coco-cashu-sqlite-bun

SQLite adapter for Bun runtime using Bun's built-in `bun:sqlite` module.

Installation:

```sh
npm i coco-cashu-sqlite-bun
```

Usage:

```ts
import { initializeCoco } from 'coco-cashu-core';
import { SqliteRepositories } from 'coco-cashu-sqlite-bun';
import { Database } from 'bun:sqlite';

// First we create a bun:sqlite client
const db = new Database('./test.db');
// Then we pass it to our storage implementation
const storage = new SqliteRepositories({ database: db });
const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

**Note:** This adapter is specifically designed for Bun runtime environments. For Node.js environments, use `coco-cashu-sqlite3` instead.
