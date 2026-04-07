# Migrating from Alpha

This guide is for teams that tested Coco during the `coco-cashu-*` alpha phase
and now want to move to the current `@cashu/*` release line.

The biggest migration is the namespace change, but this release line is also a
clean API cut. It is not a package-name-only upgrade: several alpha-era
compatibility aliases were intentionally removed.

In most codebases, the move is:

1. Replace old package names in `package.json`
2. Rewrite imports to the new `@cashu/*` names
3. Reinstall dependencies and regenerate your lockfile
4. Update any code that still uses removed alpha-era APIs

## Package rename map

| Alpha package              | Current package             |
| -------------------------- | --------------------------- |
| `coco-cashu-core`          | `@cashu/coco-core`          |
| `coco-cashu-indexeddb`     | `@cashu/coco-indexeddb`     |
| `coco-cashu-expo-sqlite`   | `@cashu/coco-expo-sqlite`   |
| `coco-cashu-sqlite3`       | `@cashu/coco-sqlite`        |
| `coco-cashu-sqlite-bun`    | `@cashu/coco-sqlite-bun`    |
| `coco-cashu-react`         | `@cashu/coco-react`         |
| `coco-cashu-adapter-tests` | `@cashu/coco-adapter-tests` |

## Update your dependencies

Replace the old alpha package names in your app:

```json
{
  "dependencies": {
    "@cashu/coco-core": "<current @cashu version>",
    "@cashu/coco-indexeddb": "<current @cashu version>"
  }
}
```

Then reinstall:

```sh
npm install
```

If you use Bun:

```sh
bun install
```

## Rewrite imports

Update import paths everywhere the old package names appear.

```ts
// before
import { initializeCoco } from 'coco-cashu-core';
import { IndexedDbRepositories } from 'coco-cashu-indexeddb';

// after
import { initializeCoco } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';
```

React projects follow the same pattern:

```tsx
// before
import { CocoCashuProvider } from 'coco-cashu-react';

// after
import { CocoCashuProvider } from '@cashu/coco-react';
```

## Node users: move from `sqlite3` to `better-sqlite3`

The old `coco-cashu-sqlite3` package has been replaced by
`@cashu/coco-sqlite`, and the adapter now uses `better-sqlite3`.

```sh
npm remove coco-cashu-sqlite3 sqlite3
npm install @cashu/coco-sqlite better-sqlite3
```

```ts
// before
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';

// after
import { SqliteRepositories } from '@cashu/coco-sqlite';
import Database from 'better-sqlite3';
```

If you are on Bun, prefer `@cashu/coco-sqlite-bun` instead.

## Required API updates

Much of the old wallet flow API was rewritten around a saga-based operation
model. The current surface for send, receive, mint, and melt lifecycles now
lives under `OpsApi`, exposed on the manager as `manager.ops.*`.

The `@cashu/*` release line intentionally removes several deprecated alpha
compatibility surfaces. If your app still used those wrappers, you must update
that code as part of the migration.

Removed manager aliases:

- `manager.send` -> `manager.ops.send`
- `manager.receive` -> `manager.ops.receive`
- `manager.quotes` -> use `manager.ops.mint` and `manager.ops.melt`
- `manager.recoverPendingSendOperations()` -> `manager.ops.send.recovery.run()`
- `manager.recoverPendingReceiveOperations()` -> `manager.ops.receive.recovery.run()`
- `manager.recoverPendingMeltOperations()` -> `manager.ops.melt.recovery.run()`

Removed `WalletApi` compatibility wrappers:

- `wallet.send()` -> `manager.ops.send.prepare()` and `manager.ops.send.execute()`
- `wallet.processPaymentRequest()` -> `manager.paymentRequests.parse()`
- `wallet.preparePaymentRequestTransaction()` -> `manager.paymentRequests.prepare()`
- `wallet.handle*PaymentRequest()` -> `manager.paymentRequests.execute()`

Breaking `WalletApi` balance changes:

- Alpha balance APIs only exposed scalar totals such as
  `wallet.getBalance(mintUrl)` and `wallet.getBalances()`
- The current release line keeps those scalar helpers, but also adds a
  canonical structured balance surface so apps can distinguish `spendable`,
  `reserved`, and `total`
- The preferred structured entrypoints are:
  `wallet.balances.byMint(scope?)`,
  `wallet.balances.total(scope?)`,
  `wallet.getBalancesByMint(scope?)`, and
  `wallet.getBalanceTotal(scope?)`
- `wallet.getSpendableBalance()`,
  `wallet.getSpendableBalances()`, and
  `wallet.getTrustedSpendableBalances()` are explicit opt-in helpers for the
  narrower spendable-only view
- `wallet.getBalanceBreakdown()`, `wallet.getBalancesBreakdown()`, and
  `wallet.getTrustedBalancesBreakdown()` still exist as legacy compatibility
  aliases using the older `ready/reserved/total` naming

Use these forms after migrating:

```ts
// preferred
await manager.ops.send.prepare({ mintUrl, amount: 100 });
await manager.ops.receive.prepare({ token });
await manager.ops.mint.prepare({ mintUrl, amount: 100, method: 'bolt11' });
await manager.ops.melt.prepare({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

const balancesByMint = await manager.wallet.balances.byMint();
const trustedBalancesByMint = await manager.wallet.balances.byMint({ trustedOnly: true });
const total = await manager.wallet.balances.total();

// compatibility helpers still exist if you only want totals
const balance = await manager.wallet.getBalance(mintUrl);
const balances = await manager.wallet.getBalances();
const trustedBalances = await manager.wallet.getTrustedBalances();
```

Notes:

- Treat `manager.ops` as the supported replacement for the older one-shot wallet
  flow helpers
- Use `manager.paymentRequests.parse()`, `prepare()`, and `execute()` for
  payment-request handling

### React hook breaking changes

The React package changed more than just import paths. The old flow hooks were
removed and replaced with operation-oriented hooks:

- `useSend()` was removed. Use `useSendOperation()`.
- `useReceive()` was removed. Use `useReceiveOperation()`.
- `useMintOperation()` and `useMeltOperation()` are new first-class hooks for
  the quote-backed flows that previously required dropping down to the manager.

The new hooks intentionally mirror `manager.ops.*`, which means the React
calling convention also changed:

- The old callback-style action options were removed. Methods now return
  promises and expose hook-managed `status`, `error`, `isLoading`, and
  `isError` state.
- Each hook binds to one operation after `prepare(...)`, `importQuote(...)`, or
  `load(operationId)`.
- Follow-up methods such as `execute()`, `refresh()`, `cancel()`, `reclaim()`,
  `finalize()`, and `checkPayment()` act on the currently bound operation, so
  you do not pass the operation id to those methods anymore.
- Hook state is now split between `currentOperation` for the persisted
  operation record and `executeResult` for execute-specific return data.
- The optional hook argument is initial-only. If a mounted component needs to
  switch to a different operation later, call `load(operationId)` explicitly.

The derived balance surfaces also changed:

- Alpha balance hooks exposed flat numeric balances only
- `useBalances()` and `useTrustedBalance()` now return a structured result with
  `balances.byMint[mintUrl]` and `balances.total`
- Each per-mint value is now a balance snapshot with
  `{ spendable, reserved, total }`
- `useBalanceContext()` follows the same structured `balances` shape
- This is a real return-shape break:
  `const { balance } = useTrustedBalance()` becomes
  `const { balances, refresh } = useTrustedBalance()`
- Code that previously read `balance[mintUrl]` or `balance.total` must now read
  `balances.byMint[mintUrl]?.total` and `balances.total.total`

Example balance-hook migration:

```tsx
// before
const { balance } = useTrustedBalance();
const mintBalance = balance[mintUrl] ?? 0;
const total = balance.total;

// after
const { balances, refresh } = useTrustedBalance();
const mintBalance = balances.byMint[mintUrl]?.total ?? 0;
const spendable = balances.byMint[mintUrl]?.spendable ?? 0;
const total = balances.total.total;
```

Example balance-context migration:

```tsx
// before
const { balance } = useBalanceContext();
const total = balance.total;

// after
const { balances } = useBalanceContext();
const total = balances.total.total;
```

Example send migration:

```tsx
// before
const { prepareSend, executePreparedSend, rollback, status, error } = useSend();

const prepared = await prepareSend(mintUrl, amount, {
  onSuccess: (op) => setPrepared(op),
});

const result = await executePreparedSend(prepared.id);
await rollback(prepared.id);

// after
const { prepare, execute, cancel, currentOperation, executeResult, status, error } =
  useSendOperation();

await prepare({ mintUrl, amount });
if (userCanceled) {
  await cancel();
} else {
  await execute();
}
```

Example receive migration:

```tsx
// before
const { receive, status, error } = useReceive();
await receive(token);

// after
const { prepare, execute, currentOperation, status, error } = useReceiveOperation();
await prepare({ token });
await execute();
```

## Existing wallet data and migrations

For the maintained adapters, keep using the same repository/database location
and initialize Coco normally.

```ts
const repo = new IndexedDbRepositories({ name: 'coco' });
const manager = await initializeCoco({ repo, seedGetter });
```

On startup:

- repository initialization runs schema setup or migrations through the adapter
- `initializeCoco()` reconciles legacy mint quote rows into mint operations
  before watchers, processors, or mint recovery start

That means alpha users should generally migrate by opening the same persisted
data with the new package names rather than exporting and re-importing wallet
state manually.

## CI, scripts, and workspace filters

If your scripts referenced the old package names, update them too.

```sh
# before
bun run --filter='coco-cashu-core' build

# after
bun run --filter='@cashu/coco-core' build
```

Do the same for any:

- Bun workspace filters
- test scripts
- release scripts
- docs snippets
- monorepo automation

## Release history and versions

The old alpha release history was archived under the repository's `history/`
directory. The `@cashu/*` packages start a new release line, so do not assume
that the latest alpha version number directly maps to the current namespaced
version number.

Upgrade by package name and API surface, not by comparing the old and new
version strings.

## Migration checklist

- Replace all `coco-cashu-*` dependencies with `@cashu/*`
- Rewrite imports to the new namespace
- For Node, switch from `sqlite3` to `better-sqlite3`
- Reinstall dependencies and regenerate the lockfile
- Replace removed alpha-era manager and `WalletApi` wrappers with
  `manager.ops.*` and `manager.paymentRequests.*`
- Update Bun workspace filters and CI scripts
- Start the app against your existing persisted data and verify balances,
  pending operations, and mint subscriptions
