# @cashu/coco-sqlite

Node storage adapter for Coco built on `better-sqlite3`.

The public entry point is `SqliteRepositories`. Open the `better-sqlite3`
database in your application, pass that already-opened database instance to the
adapter, and keep ownership of the database lifecycle.

## Install

```bash
npm install @cashu/coco-core @cashu/coco-sqlite better-sqlite3
```

## Usage

```ts
import Database from 'better-sqlite3';
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite';

const database = new Database('./coco.db');
const repositories = new SqliteRepositories({ database });
await repositories.init();

const manager = await initializeCoco({
  repo: repositories,
  seedGetter,
});
```

When your application shuts down, close `database` from your own code. The
adapter does not close a database that it did not open.

## Public API

- Import `SqliteRepositories` and `SqliteRepositoriesOptions` from
  `@cashu/coco-sqlite`.
- Pass an already-opened `better-sqlite3` database with the `database` option.
- Call `repositories.init()` before using the manager so schema creation and
  migrations run.
- Migration helpers, database wrapper classes, and individual repository classes
  are internal implementation details and are not public adapter exports.

## Notes

- The `coco_cashu_keysets` table no longer has a foreign key to `coco_cashu_mints`. Keysets are deleted manually in the repository when a mint is deleted. This improves compatibility with backends that cannot perform async work inside transactions (e.g., IndexedDB) and avoids FK timing issues during initial sync.
