# Hooks

Hooks are built on top of the providers and the core `Manager` API. Make sure your component tree is wrapped with `ManagerProvider` (or `CocoCashuProvider`).

## useSend

Provides a two-step send flow that mirrors the core send saga. This is the recommended way to send tokens from the UI. `status` is one of `idle`, `loading`, `success`, or `error`.

```tsx
import { useSend } from 'coco-cashu-react';

const {
  prepareSend,
  executePreparedSend,
  rollback,
  finalize,
  getPendingOperations,
  getOperation,
  status,
  data,
  error,
  reset,
  isSending,
  isError,
} = useSend();

const prepared = await prepareSend(mintUrl, 100);
const { operation, token } = await executePreparedSend(prepared.id);
```

`send()` is still available but deprecated. Use `prepareSend()` followed by `executePreparedSend()` for better control and fee transparency.

## useReceive

Receives a token with simple status tracking. `status` follows the same `idle` to `error` lifecycle and `reset()` returns it to `idle`.

```tsx
import { useReceive } from 'coco-cashu-react';

const { receive, status, error, reset, isReceiving } = useReceive();

await receive(token, {
  onSuccess: () => console.log('Received'),
  onError: (err) => console.error(err),
});
```

## usePaginatedHistory

Provides paginated access to history and auto-refreshes on `history:updated` events.

```tsx
import { usePaginatedHistory } from 'coco-cashu-react';

const { history, loadMore, goToPage, refresh, hasMore, isFetching } = usePaginatedHistory(50);
```

## useTrustedBalance

Returns balances only for trusted mints and a total across those mints. This hook depends on `MintProvider` and `ManagerProvider`.

```tsx
import { useTrustedBalance } from 'coco-cashu-react';

const { balance } = useTrustedBalance();
```
