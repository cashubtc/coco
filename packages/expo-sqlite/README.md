# @cashu/coco-expo-sqlite

Expo SQLite storage adapter for Coco in React Native and Expo applications.

The public entry point is `createSqliteStorage`. Open the `expo-sqlite` database
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
import { createSqliteStorage } from '@cashu/coco-expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

const database = await openDatabaseAsync('coco.db');
const storage = createSqliteStorage({ database });

const manager = await initializeCoco({
  storage: storage,
  seedGetter,
});
```

The adapter does not close a database that it did not open. Keep the Expo
database lifecycle under your application code.

## Public API

- `createSqliteStorage({ database, mintSwap? })` returns opaque `CocoStorage`.
- `initializeCoco` awaits `storage.init()` automatically. Manual callers await it before `new Manager(storage, seedGetter)`.
- The caller opens and closes the database. `Manager.dispose()` does not close it.
- The adapter owns connection pragmas; Coco owns schema migrations and repositories.
- Match core, SQL storage, and adapter release versions. Mismatches fail before database access.
- `/internal` exports have **no compatibility or versioning guarantees, including patch/minor releases**.
