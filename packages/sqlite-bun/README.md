# @cashu/coco-sqlite-bun

SQLite adapter for Coco using Bun's built-in `bun:sqlite` module.

The public entry point is `SqliteRepositories`. Open the `bun:sqlite` database
in your application, pass that already-opened database instance to the adapter,
and keep ownership of the database lifecycle.

## Install

```bash
bun add @cashu/coco-core @cashu/coco-sqlite-bun
```

## Usage

```ts
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';

const database = new Database(':memory:');
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
  `@cashu/coco-sqlite-bun`.
- Pass an already-opened `bun:sqlite` database with the `database` option.
- Call `repositories.init()` before using the manager so schema creation and
  migrations run.
- Migration helpers, database wrapper classes, and individual repository classes
  are internal implementation details and are not public adapter exports.

## Durable event outbox

The generic outbox is opt-in. `SqliteRepositories` exposes:

- `durableEventOutbox.run()` for publisher claims, inspection, requeue, and compaction;
- `withDurableEventOutboxTransaction()` for committing Wallet repository changes and a sealed event
  batch together; and
- `configureDurableEventOutboxStorageLimits()` for persisted finite capacity limits.

SQLite busy/locked conflicts can repeat the combined transaction callback. Create stable IDs,
timestamps, and payload inputs before entering it, and do not perform network or other external
effects inside it.

## Notes

- Uses `bun:sqlite` instead of `better-sqlite3`.
- Designed specifically for Bun runtime.
- No external SQLite dependency is required.

## Testing

```bash
bun test
```
