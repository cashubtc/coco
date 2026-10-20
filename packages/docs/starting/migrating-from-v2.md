# Migrating from v2 to v3 storage

V3 encapsulates repositories. Applications choose opaque storage and keep using the same Wallet APIs.
Existing persisted Wallet records and Operation Recovery remain supported; this change adds no data
format migration of its own.

```diff
- import { SqliteRepositories } from '@cashu/coco-sqlite';
- const repo = new SqliteRepositories({ database: db });
- const coco = await initializeCoco({ repo, seedGetter });
+ import { createSqliteStorage } from '@cashu/coco-sqlite';
+ const storage = createSqliteStorage({ database: db });
+ const coco = await initializeCoco({ storage, seedGetter });
```

| Backend     | Factory                                                                  | Ownership                                                        |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Memory      | `createMemoryStorage()` from core                                        | Data lives with the handle                                       |
| IndexedDB   | `createIndexedDbStorage({ name?, mintSwap? })`                           | Coco opens; caller invokes `storage.close()` after work finishes |
| Node SQLite | `createSqliteStorage({ database, mintSwap? })` from `@cashu/coco-sqlite` | Caller opens and closes `better-sqlite3`                         |
| Bun SQLite  | Same factory from `@cashu/coco-sqlite-bun`                               | Caller opens and closes `bun:sqlite`                             |
| Expo SQLite | Same factory from `@cashu/coco-expo-sqlite`                              | Caller opens and closes `expo-sqlite`                            |

`initializeCoco` is the recommended entry point. It awaits `storage.init()`, initializes plugins,
reconciles legacy quotes, starts enabled background components and performs Operation Recovery.
Disabling all watchers and processors still runs the other startup steps.

## Advanced manual startup

The public `Manager` constructor remains fully supported. Its first argument is now opaque storage;
its other arguments retain their meaning. Await initialization before using the session:

```ts
import { Manager } from '@cashu/coco-core';
import { createIndexedDbStorage } from '@cashu/coco-indexeddb';

const storage = createIndexedDbStorage({ name: 'wallet' });
await storage.init();
const coco = new Manager(storage, seedGetter);
// Perform the startup actions your application deliberately controls.
```

Construction only wires the session. It does not start asynchronous initialization, initialize plugins,
reconcile legacy quotes, recover operations or start background components. The manual caller remains
responsible for these choices; using the canonical factory is the way to obtain its complete startup
sequence. Manual construction is neither deprecated nor internal.

Successful `init()` means opening and migrations have completed. IndexedDB now explicitly opens during
initialization, so opening and migration failures surface earlier. Finish all work before closing
storage. `storage.close()` releases IndexedDB without deleting data; SQLite connections remain
caller-owned. `Manager.dispose()` does not close storage. There is no new draining, reopening or
one-session-per-handle guarantee or restriction.

## Extension and version boundaries

Public repository classes, `CocoConfig.repo`, and core's stable `/adapter` entry point are removed.
There is no repository-injection compatibility shim. `ProofUnitFilter` remains public from core with
the same `{ unit?: string; units?: string[] }` shape. Existing plugin service methods and public API
constructors remain supported.

Install matching releases of core and Coco-owned storage implementation packages. Mismatches fail
before database access. Internal entry points and `@cashu/coco-adapter-tests` provide **no compatibility
or versioning guarantees, including patch/minor releases**. Technical importability is not a supported
adapter contract. Opacity is not a security boundary.

Independent authors can implement the stable SQLite driver contract in `@cashu/coco-sql-storage` and
use its storage factory and `/test` conformance suite. Driver packages need not share Coco's version.
See the [driver contract](https://github.com/cashubtc/coco/blob/master/packages/sql-storage/README.md).
Arbitrary repository implementations, PostgreSQL, and a complete Durable Objects adapter remain out
of scope. A future public driver contract change can still require a breaking release.
