# @cashu/coco-sqlite

Node storage adapter for Coco built on `better-sqlite3`.

The public entry point is `createSqliteStorage`. Open the `better-sqlite3`
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
import { createSqliteStorage } from '@cashu/coco-sqlite';

const database = new Database('./coco.db');
const storage = createSqliteStorage({ database });

const manager = await initializeCoco({
  storage: storage,
  seedGetter,
});
```

When your application shuts down, close `database` from your own code. The
adapter does not close a database that it did not open.

## Public API

- `createSqliteStorage({ database, mintSwap? })` returns opaque `CocoStorage`.
- `initializeCoco` awaits `storage.init()` automatically. Manual callers await it before `new Manager(storage, seedGetter)`.
- The caller opens and closes the database. `Manager.dispose()` does not close it.
- The adapter owns connection pragmas; Coco owns schema migrations and repositories.
- Match core, SQL storage, and adapter release versions. Mismatches fail before database access.
- `/internal` exports have **no compatibility or versioning guarantees, including patch/minor releases**.
