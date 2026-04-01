# Hooks

Hooks are built on top of the providers and the core `Manager` API. Make sure
your component tree is wrapped with `ManagerProvider` or
`CocoCashuProvider`.

The operation hooks intentionally mirror `manager.ops.*` instead of inventing a
separate React-only workflow model:

- render from `currentOperation`
- use `executeResult` for execute-specific output only
- optionally initialize a hook with an operation or `operationId` on first render
- call `load(operationId)` to resume persisted work or explicitly rebind the hook
- call follow-up methods on the currently bound operation
- use `status`, `error`, `isLoading`, and `isError` for local hook state

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
  load,
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
start from persisted work with `useSendOperation(initialOperationOrId)` or
`load(operationId)`.

The `initialOperationOrId` argument is initial-only. If a component stays
mounted and you need to switch the hook to a different persisted operation,
call `load(operationId)` explicitly. Changing the hook argument on a later
render does not rebind the hook.

## useReceiveOperation

Use this to decode, prepare, execute, resume, and cancel receives via
`manager.ops.receive.*`.

```tsx
import { useReceiveOperation } from '@cashu/coco-react';

const { prepare, execute, currentOperation, load, refresh, cancel } = useReceiveOperation();

await prepare({ token });
await execute();
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

await prepare({ mintUrl, amount: 100, method: 'bolt11' });
await checkPayment();
```

`prepare()` and `importQuote()` both create a pending mint operation.

## useMeltOperation

Use this for outbound payment flows such as bolt11 melts.

```tsx
import { useMeltOperation } from '@cashu/coco-react';

const { prepare, execute, refresh, finalize, reclaim, currentOperation } = useMeltOperation();

await prepare({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});
await execute();
```

## Derived-data Hooks

The existing derived-data hooks remain available for balance and history views.

```tsx
import { usePaginatedHistory, useTrustedBalance } from '@cashu/coco-react';

const { history, loadMore, goToPage, refresh, hasMore, isFetching } = usePaginatedHistory(50);
const { balance } = useTrustedBalance();
```
