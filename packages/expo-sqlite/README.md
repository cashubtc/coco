# @cashu/coco-expo-sqlite

Expo SQLite storage adapter for Coco in React Native and Expo applications.

The public entry point is `SqliteRepositories`. Open the `expo-sqlite` database
in your application, pass that already-opened database instance to the adapter,
and keep ownership of the database lifecycle.

## Install

```bash
npm install @cashu/coco-core @cashu/coco-expo-sqlite
npx expo install expo-sqlite
```

## Usage

```ts
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

const database = await openDatabaseAsync('coco.db');
const repositories = new SqliteRepositories({ database });
await repositories.init();

const manager = await initializeCoco({
  repo: repositories,
  seedGetter,
});
```

The adapter does not close a database that it did not open. Keep the Expo
database lifecycle under your application code.

## Public API

- Import `SqliteRepositories` and `SqliteRepositoriesOptions` from
  `@cashu/coco-expo-sqlite`.
- Pass an already-opened `expo-sqlite` database with the `database` option.
- Call `repositories.init()` before using the manager so schema creation and
  migrations run.
- `ExpoSqliteRepositories` remains available as an alias for
  `SqliteRepositories`.
- `ExpoSqliteRepositoriesOptions` remains available as an alias for
  `SqliteRepositoriesOptions`.
- Migration helpers, database wrapper classes, and individual repository classes
  are internal implementation details and are not public adapter exports.

## Durable event outbox

The generic outbox repository is enabled and opt-in. `SqliteRepositories` exposes:

- `durableEventOutbox.run()` for publisher claims, inspection, requeue, and compaction;
- `withDurableEventOutboxTransaction()` for committing Wallet repository changes and a sealed event
  batch together; and
- `configureDurableEventOutboxStorageLimits()` for persisted finite capacity limits.

On native platforms, outbox transactions use Expo's isolated transaction connection so unrelated
queries issued through the application-owned database cannot join the outbox commit. Expo web and
older runtimes without `withExclusiveTransactionAsync` cannot provide that boundary, so the outbox
transaction capability rejects there. SQLite busy/locked conflicts can repeat the combined
transaction callback, so create stable inputs beforehand and do not perform external effects inside
it. A concrete Expo feature rollout should still run its producer/consumer transaction and
competing-claim tests on the supported native devices.

## Notes

- Pass an already opened `expo-sqlite` database instance via the `database` option.
- The adapter ensures schema creation and migrations when you call `init()`.
- `ExpoSqliteRepositories` remains available as a migration alias.
- Migration 039 provisions the generic durable outbox tables and persisted capacity policy.
