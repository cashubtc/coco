# React Overview

The `@cashu/coco-react` package provides React providers and hooks around a
Coco `Manager` so UI code can access balance, mints, history, and
operation-oriented send, receive, mint, and melt flows.

The canonical lifecycle surface lives under `manager.ops.*` in core. The React
package mirrors that model directly with:

- `useSendOperation()`
- `useReceiveOperation()`
- `useMintOperation()`
- `useMeltOperation()`

Each hook exposes the same durable-operation story:

- `currentOperation` for the persisted operation state you should render from
- `executeResult` for the last execute-specific result
- optional initial binding via an operation or `operationId` on first render
- `load(operationId)` for resume flows and explicit rebinding
- no-arg follow-up actions that operate on the currently bound operation
- `status`, `error`, `isLoading`, and `isError` for local async state

The optional hook argument is initial-only. If your UI stays mounted while the
target operation changes, call `load(operationId)` to switch the hook to the
new operation.

## Installation

```sh
npm i @cashu/coco-react @cashu/coco-core
```

`react` is a peer dependency. Make sure your app is using React 19.

## Setup

Create a `Manager` with `@cashu/coco-core`, then pass it to the provider. If
your manager is created asynchronously, render a loading state until you have a
`Manager` instance, then render the provider.

```tsx
import { useEffect, useState } from 'react';
import type { Manager } from '@cashu/coco-core';
import { initializeCoco } from '@cashu/coco-core';
import { CocoCashuProvider } from '@cashu/coco-react';

export function App() {
  const [manager, setManager] = useState<Manager | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    void initializeCoco({ repo, seedGetter })
      .then((instance) => {
        if (!cancelled) setManager(instance);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div>Failed</div>;
  if (!manager) return <div>Loading wallet...</div>;

  return (
    <CocoCashuProvider manager={manager}>
      <Wallet />
    </CocoCashuProvider>
  );
}
```

`CocoCashuProvider` is a convenience wrapper that composes `ManagerProvider`,
`MintProvider`, and `BalanceProvider`.

For operation hooks, `ManagerProvider` is the only required context. The mint
and balance providers are only needed for derived-data hooks such as
`useBalances()`, `useTrustedBalance()`, and `useMints()`.
