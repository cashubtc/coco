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
- `executeResult` for the last execute-specific result, not the general
  operation state
- optional initial binding via an operation or `operationId` on first render
- internal mount-time hydration when initialized with an `operationId`
- no-arg follow-up actions that operate on the currently bound operation
- `status`, `error`, `isLoading`, and `isError` for local async state

The optional hook argument is initial-only. If your UI stays mounted while the
target operation changes, remount the hook or component with a new React `key`.
Use `refresh()` for stale persisted operations or recovery UI, not as normal
happy-path polling. Lifecycle events update the bound `currentOperation`
automatically when watchers, processors, or explicit actions move it forward.

## Installation

```sh
npm i @cashu/coco-react @cashu/coco-core
```

`react` is a peer dependency. Make sure your app is using React 19.

## Setup

Pass the same config accepted by `initializeCoco()` to `CocoCashuProvider`. The
provider initializes the manager on initial mount and renders `fallback` until
the manager is ready.

```tsx
import { CocoCashuProvider } from '@cashu/coco-react';

export function App() {
  return (
    <CocoCashuProvider
      config={{ repo, seedGetter }}
      fallback={<div>Loading wallet...</div>}
      errorFallback={<div>Failed</div>}
    >
      <Wallet />
    </CocoCashuProvider>
  );
}
```

`CocoCashuProvider` is a convenience wrapper that composes `ManagerProvider`,
`MintProvider`, and `BalanceProvider`.

The `config` prop is initial-only. If you need to rebuild Coco with a different
configuration, remount `CocoCashuProvider` with a new React `key`.

If your application already owns initialization, pass an existing manager:

```tsx
<CocoCashuProvider manager={manager}>
  <Wallet />
</CocoCashuProvider>
```

For operation hooks, `ManagerProvider` is the only required context. The mint
and balance providers are only needed for derived-data hooks such as
`useBalances()`, `useTrustedBalance()`, and `useMints()`.
