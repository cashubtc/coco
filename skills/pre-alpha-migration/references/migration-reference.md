# Alpha To Stable Migration Reference

Use this reference when applying or reviewing a migration from the legacy
`coco-cashu-*` alpha packages to the stable `@cashu/*` release line.

## Package Rename Map

| Alpha package              | Stable package            |
| -------------------------- | ------------------------- |
| `coco-cashu-core`          | `@cashu/coco-core`        |
| `coco-cashu-indexeddb`     | `@cashu/coco-indexeddb`   |
| `coco-cashu-expo-sqlite`   | `@cashu/coco-expo-sqlite` |
| `coco-cashu-sqlite3`       | `@cashu/coco-sqlite`      |
| `coco-cashu-sqlite-bun`    | `@cashu/coco-sqlite-bun`  |
| `coco-cashu-react`         | `@cashu/coco-react`       |
| `coco-cashu-adapter-tests` | `@cashu/coco-adapter-tests` |

## Dependency And Import Updates

- Replace old package names in `package.json`.
- Rewrite import specifiers everywhere the old package names appear.
- Reinstall dependencies and regenerate the lockfile.
- Update Bun workspace filters, build scripts, release scripts, CI config, and
  docs snippets that still reference the alpha package names.

## SQLite Adapter Migration

For Node users:

- `coco-cashu-sqlite3` becomes `@cashu/coco-sqlite`
- `sqlite3` becomes `better-sqlite3`

Before:

```ts
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';
```

After:

```ts
import { SqliteRepositories } from '@cashu/coco-sqlite';
import Database from 'better-sqlite3';
```

For Bun users, prefer `@cashu/coco-sqlite-bun`.

## Removed Manager Aliases

- `manager.send` -> `manager.ops.send`
- `manager.receive` -> `manager.ops.receive`
- `manager.quotes` -> use `manager.ops.mint` and `manager.ops.melt`
- `manager.recoverPendingSendOperations()` ->
  `manager.ops.send.recovery.run()`
- `manager.recoverPendingReceiveOperations()` ->
  `manager.ops.receive.recovery.run()`
- `manager.recoverPendingMeltOperations()` ->
  `manager.ops.melt.recovery.run()`

## Removed WalletApi Compatibility Wrappers

- `wallet.send()` ->
  `manager.ops.send.prepare()` and `manager.ops.send.execute()`
- `wallet.processPaymentRequest()` -> `manager.paymentRequests.parse()`
- `wallet.preparePaymentRequestTransaction()` ->
  `manager.paymentRequests.prepare()`
- `wallet.handle*PaymentRequest()` -> `manager.paymentRequests.execute()`

Preferred stable operation entrypoints:

```ts
await manager.ops.send.prepare({ mintUrl, amount: 100 });
await manager.ops.receive.prepare({ token });
await manager.ops.mint.prepare({ mintUrl, amount: 100, method: 'bolt11' });
await manager.ops.melt.prepare({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});
```

## Wallet Balance Changes

The stable release keeps scalar helpers but introduces a canonical structured
balance surface so apps can distinguish `spendable`, `reserved`, and `total`.

Preferred structured entrypoints:

- `wallet.balances.byMint(scope?)`
- `wallet.balances.total(scope?)`
- `wallet.getBalancesByMint(scope?)`
- `wallet.getBalanceTotal(scope?)`

Spendable-only helpers:

- `wallet.getSpendableBalance()`
- `wallet.getSpendableBalances()`
- `wallet.getTrustedSpendableBalances()`

Legacy compatibility aliases still available:

- `wallet.getBalanceBreakdown()`
- `wallet.getBalancesBreakdown()`
- `wallet.getTrustedBalancesBreakdown()`

Scalar helpers that still exist:

```ts
const balance = await manager.wallet.getBalance(mintUrl);
const balances = await manager.wallet.getBalances();
const trustedBalances = await manager.wallet.getTrustedBalances();
```

Structured examples:

```ts
const balancesByMint = await manager.wallet.balances.byMint();
const trustedBalancesByMint = await manager.wallet.balances.byMint({
  trustedOnly: true,
});
const total = await manager.wallet.balances.total();
```

## React Hook Breaking Changes

Removed and replaced hooks:

- `useSend()` -> `useSendOperation()`
- `useReceive()` -> `useReceiveOperation()`
- `useMintOperation()` and `useMeltOperation()` are now first-class hooks

Stable hook model:

- methods return promises instead of callback-style action options
- hooks expose `status`, `error`, `isLoading`, and `isError`
- each hook binds to one operation after `prepare(...)`, `importQuote(...)`, or
  `load(operationId)`
- follow-up methods such as `execute()`, `refresh()`, `cancel()`, `reclaim()`,
  `finalize()`, and `checkPayment()` operate on the currently bound operation
- state is split between `currentOperation` and `executeResult`
- the optional hook argument is initial-only; later switches use
  `load(operationId)`

Send migration example:

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

Receive migration example:

```tsx
// before
const { receive, status, error } = useReceive();
await receive(token);

// after
const { prepare, execute, currentOperation, status, error } = useReceiveOperation();
await prepare({ token });
await execute();
```

## React Balance Shape Changes

The balance hooks no longer return a flat numeric object. They now return a
structured `balances` object.

Before:

```tsx
const { balance } = useTrustedBalance();
const mintBalance = balance[mintUrl] ?? 0;
const total = balance.total;
```

After:

```tsx
const { balances, refresh } = useTrustedBalance();
const mintBalance = balances.byMint[mintUrl]?.total ?? 0;
const spendable = balances.byMint[mintUrl]?.spendable ?? 0;
const total = balances.total.total;
```

Balance context migration:

```tsx
// before
const { balance } = useBalanceContext();
const total = balance.total;

// after
const { balances } = useBalanceContext();
const total = balances.total.total;
```

## Persisted Wallet Data

For maintained adapters, keep using the same repository or database location
and initialize Coco normally.

```ts
const repo = new IndexedDbRepositories({ name: 'coco' });
const manager = await initializeCoco({ repo, seedGetter });
```

Migration expectations on startup:

- adapter initialization performs schema setup or migrations
- `initializeCoco()` reconciles legacy mint quote rows into mint operations
  before watchers, processors, or mint recovery start

In normal upgrades, do not add manual wallet export and re-import steps.

## Release Line Notes

- The `@cashu/*` packages start a new release line.
- Do not assume the latest alpha version number maps directly to the stable
  namespaced version number.
- Upgrade by package name and API surface, not by comparing version strings.

## Final Checklist

- Replace all `coco-cashu-*` dependencies with `@cashu/*`
- Rewrite imports to the new namespace
- For Node, switch from `sqlite3` to `better-sqlite3`
- Reinstall dependencies and regenerate the lockfile
- Replace removed alpha manager and `WalletApi` wrappers with `manager.ops.*`
  and `manager.paymentRequests.*`
- Update React flow hooks and balance reads if present
- Update Bun workspace filters and CI scripts
- Start the app against existing persisted data
- Verify balances, pending operations, and mint subscriptions
