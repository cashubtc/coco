# Storage Adapters

Coco is built in a platform agnostic way. As we can not assume anything about the presence of a certain storage API (e.g. IndexedDb), coco exposes a storage interface that needs to be statisfied when instantiating.

```ts
const repo = new ExpoSqliteRepositories({ database: db }); // Implements the CocoRepository interface
await repo.init(); // Ensures schema and applies migrations
const coco = new Manager(
  repo, // <-- pass the storage implementation to the manager
  // other params
);
```

Some storage implementations are maintained as part of the cashubtc/coco repository, but technically you can use any class that implements the CocoRepositories interface.

## coco-cashu-indexeddb

Implements CocoRepositories using the Indexeddb Browser API.

Installation:

```sh
npm i coco-cashu-indexeddb
```

Usage:

```ts
const repo = new IndexedDbRepositories({ name: 'your-db-name' });
await repo.init();
const coco = new Manager(
  repo,
  // other params
);
```

## coco-cashu-expo-sqlite

Installation:

```sh
npm i coco-cashu-expo-sqlite
# coco-cashu-expo-sqlite expects a Expo SQLite client to be passed
npx expo install expo-sqlite
```

Usage:

```ts
// First we create a expo-sqlite client
const db = await openDatabaseAsync('coco-demo.db');
// Then we pass it to our storage implementation
const repo = new ExpoSqliteRepositories({ database: db });
await repo.init();
const manager = new Manager(
  repo,
  // other params
);
```

## coco-cashu-sqlite3

Installation:

```sh
npm i coco-cashu-sqlite3
npm i sqlite3
```

Usage:

```ts
// First we create a sqlite3 client
const db = new Database('./test.db');
// Then we pass it to our storage implementation
const repo = new SqliteRepositories({ database: db });
await repo.init();
const manager = new Manager(
  repo,
  // other params
);
```
