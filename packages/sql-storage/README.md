# @cashu/coco-sql-storage

Shared SQLite storage for Coco. Runtime authors implement `SqlDatabase`; Coco owns repositories,
queries, serialization and schema migrations. Applications receive an opaque `CocoStorage`.

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createSqliteStorage, type SqlDatabase } from '@cashu/coco-sql-storage';

declare const database: SqlDatabase; // Your runtime binding; see the contract below.
const coco = await initializeCoco({ storage: createSqliteStorage({ database }), seedGetter });
```

The factory accepts `{ database, mintSwap? }`. It borrows the driver and never closes its connection.
`storage.init()` completes all migrations; `initializeCoco` calls it automatically. For advanced manual
startup, await it before `new Manager(storage, seedGetter)`.

## Driver contract

| Member                        | Required behavior                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(sql)`                   | Execute a SQLite script containing one or more statements, in order. No bound parameters. Reject on failure.                                                                                                  |
| `run(sql, params?)`           | Bind positional `?` values; return `{ changes, lastInsertRowId }`. `changes` is the number of affected rows, including zero for a failed conditional update.                                                  |
| `get<Row>(sql, params?)`      | Return the first row as a column-name object, or `undefined` for no row.                                                                                                                                      |
| `all<Row>(sql, params?)`      | Return all rows as column-name objects, or `[]` for no rows.                                                                                                                                                  |
| `transaction(work, options?)` | Supply a scoped driver. Resolve with the callback result only after commit; reject only after rollback or a failed begin. See failure semantics below.                                                        |
| `maxParameters?`              | Maximum bound values per statement, including fixed predicates. Defaults to 999. Must be a safe integer at least 32. Set 100 for a runtime with a 100-value limit. Scoped drivers must retain the same limit. |

Parameters are readonly arrays of `string | number | bigint | Uint8Array | null`. Omitted parameters
mean `[]`. Preserve strings, blobs and nulls; bind integers without truncating the input. Numeric
columns used by Coco and run-result counts/row IDs must be returned as JavaScript numbers within
their safe range. Coco stores large monetary amounts as decimal text. `lastInsertRowId` is SQLite's
last inserted row ID on the connection; it is meaningful after a row-ID insert, not a new ID promised
for every update. Row generics describe the expected result; they do not request runtime conversion.

Runtime bindings own connection settings. Shared migrations do not issue connection-specific
pragmas. Official adapters retain foreign keys, WAL, normal synchronous mode and a 5000 ms busy
timeout where applicable. Set up your own runtime before passing the driver to Coco.

## Transactions and failures

- All authoritative reads and resulting writes share one atomic transaction. Conflicting writers
  serialize or reject with `SqlTransactionConflictError`; incompatible decisions cannot both commit.
- `mode: 'immediate'` requests writer ownership before authoritative reads. An equivalent host
  transaction mechanism is valid; literal `BEGIN IMMEDIATE` is not required. Ignoring the option
  without providing equivalent isolation is not valid.
- Calls to `transaction` on the scoped driver join the parent, including parent rollback. Use the
  scoped driver for all callback SQL. Unrelated root work must stay outside that transaction.
- Await all scoped work; do not retain a scoped driver beyond its callback. Low-level joining does
  not authorize nested Coco Wallet transactions.
- Preserve ordinary callback errors. Throw `SqlTransactionConflictError` only when the attempt
  certainly did not commit and rollback has completed, or begin failed before a transaction opened.
  Coco translates this error into its existing bounded retry policy.
- An uncertain commit or failed rollback must reject with an ordinary error, preserving its cause;
  it must never be classified as retryable. Coco does not infer conflicts from error messages/codes
  returned by third-party drivers.
- Do not replay callbacks inside the driver. Host-managed callback replay needs separate evaluation
  against Coco's retry and scope-lifetime behavior before claiming support for that runtime.

This contract targets compatible SQLite runtimes, not PostgreSQL or every SQLite-branded service.
Runtimes without the required interactive transaction semantics are unsupported. This package does
not itself provide or certify a Durable Objects adapter.

## Conformance

```ts
import { describe, it, expect } from 'your-test-runner';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';

runSqlDatabaseContract(
  {
    createDatabase: async () => ({ database: await openFreshDriver(), dispose: closeDriver }),
  },
  { describe, it, expect },
);
```

Each test needs a fresh database. Run against the actual runtime. The suite covers scripts, binding,
results, conditional writes, commit/rollback, scoped joining, concurrent decisions and root exclusion.
Passing it is useful evidence, not proof of every host-specific failure or cross-connection guarantee.
Validate those guarantees and limits for the runtime you distribute.

## Compatibility

The root and `/test` are supported APIs with normal compatibility guarantees. Independent driver
packages need compatible semantics, not the same package version as Coco. Core and Coco-owned
implementation packages must use matching release versions; mismatches fail before database access.

`/internal` exports and the `@cashu/coco-adapter-tests` package have **no compatibility or versioning
guarantees, including patch/minor releases**. They expose Coco's implementation machinery for its own
packages and tests. Repository contracts, migrations and serializers are not supported public APIs.
