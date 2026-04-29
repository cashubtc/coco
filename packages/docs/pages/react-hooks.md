# Hooks

Hooks are built on top of the providers and the core `Manager` API. Make sure
your component tree is wrapped with `ManagerProvider` or
`CocoCashuProvider`.

## Operation Hook Contract

The operation hooks intentionally mirror `manager.ops.*` instead of inventing a
separate React-only workflow model. One hook instance owns one active operation.

- `currentOperation` is the authoritative operation record to render from.
- `executeResult` is only for execute-specific returned data, such as the token
  returned by `useSendOperation().execute()`.
- Creation methods such as `prepare(...)` and `importQuote(...)` bind the hook to
  the operation they create.
- Follow-up methods such as `execute()`, `checkPayment()`, `finalize()`,
  `cancel()`, `reclaim()`, and `refresh()` operate on the currently bound
  operation, so app code should not pass an `operationId` to those methods.
- The optional hook argument is initial-only. Use it to seed a resume screen from
  an operation object or load one persisted operation by id on mount.
- The hooks subscribe to lifecycle events and update the bound operation when the
  manager emits a newer state for that operation id.
- `refresh()` is for stale persisted operations, recovery screens, or explicit
  user refresh actions. It is not needed as happy-path polling.
- `reset()` clears the hook's local binding, `executeResult`, `status`, and
  `error`. It does not roll back or delete the persisted operation.
- `status`, `error`, `isLoading`, and `isError` describe the hook's current local
  async action. If a second stateful action is started while one is already
  running, the second call rejects and does not replace the loading/error state
  from the first action.

For state-machine details, see [Send Operations](./send-operations.md),
[Receive Operations](./receive-operations.md), [Mint Operations](./mint-operations.md),
and [Melt Operations](./melt-operations.md).

## useSendOperation

Use this for the full send lifecycle, including resume, reclaim, and finalize
flows.

```tsx
import { useSendOperation } from '@cashu/coco-react';

const {
  prepare,
  execute,
  currentOperation,
  executeResult,
  refresh,
  cancel,
  reclaim,
  finalize,
  listPrepared,
  listInFlight,
  status,
  error,
  reset,
  isLoading,
  isError,
} = useSendOperation();

await prepare({ mintUrl, amount: 100 });
// after the user reviews the prepared operation:
const { operation, token } = await execute();
```

`currentOperation` is the persisted operation state you render from. Once the
hook is bound, methods such as `execute()`, `refresh()`, `cancel()`,
`reclaim()`, and `finalize()` operate on that bound operation. You can also
start from persisted work with `useSendOperation(initialOperationOrId)`.

The `initialOperationOrId` argument is initial-only. If a component stays
mounted and you need to switch the hook to a different persisted operation,
remount the hook or component with a new React `key`. Changing the hook
argument on a later render does not rebind the hook.

## useReceiveOperation

Use this to decode, prepare, execute, resume, and cancel receives via
`manager.ops.receive.*`.

```tsx
import { useReceiveOperation } from '@cashu/coco-react';

const { prepare, execute, currentOperation, refresh, cancel } = useReceiveOperation();

const preparedReceive = await prepare({ token });

if (preparedReceive.state === 'prepared') {
  await execute();
}
```

## useMintOperation

Use this for quote-backed mint lifecycles, including imported quotes and remote
payment checks.

```tsx
import { useMintOperation } from '@cashu/coco-react';

const {
  prepare,
  importQuote,
  execute,
  checkPayment,
  finalize,
  currentOperation,
  executeResult,
  listPending,
  listInFlight,
} = useMintOperation();

const pendingMint = await prepare({ mintUrl, amount: 100, method: 'bolt11' });

if (pendingMint.state === 'pending') {
  await checkPayment();
}
```

`prepare()` and `importQuote()` both create a pending mint operation.

## useMeltOperation

Use this for outbound payment flows such as bolt11 melts.

```tsx
import { useMeltOperation } from '@cashu/coco-react';

const { prepare, execute, refresh, finalize, reclaim, currentOperation } = useMeltOperation();

const preparedMelt = await prepare({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

if (preparedMelt.state === 'prepared') {
  await execute();
}
```

## Derived-data Hooks

The existing derived-data hooks remain available for balance and history views.

```tsx
import { useBalances, usePaginatedHistory, useTrustedBalance } from '@cashu/coco-react';

const { balances, refresh: refreshBalances } = useBalances();
const {
  history,
  loadMore,
  goToPage,
  refresh: refreshHistory,
  hasMore,
  isFetching,
} = usePaginatedHistory(50);
const { balances: trustedBalances } = useTrustedBalance();
```

`useBalances()` returns the full wallet snapshot:

- `balances.byMint[mintUrl].spendable`
- `balances.byMint[mintUrl].reserved`
- `balances.byMint[mintUrl].total`
- `balances.total`

`useTrustedBalance()` applies the same structured shape, filtered to trusted
mints only.
