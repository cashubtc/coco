# React integration

Use `@cashu/coco-react` with compatible core and React peer versions. Place the provider in a
client-only wallet subtree after unlock. Keep the repository and seed getter stable for that
Wallet's lifetime.

## Choose the session owner

Let the provider own initialization and disposal when the React subtree owns the session:

```tsx
import type { CocoConfig } from '@cashu/coco-core';
import { CocoCashuProvider } from '@cashu/coco-react';
import type { ReactNode } from 'react';

export function WalletRoot({ config, children }: { config: CocoConfig; children: ReactNode }) {
  return (
    <CocoCashuProvider
      config={config}
      fallback={<p>Opening wallet…</p>}
      errorFallback={<p>Could not open this wallet. Unlock it and retry.</p>}
    >
      {children}
    </CocoCashuProvider>
  );
}
```

Pass `{ repo: new IndexedDbRepositories({ name: walletDatabaseName }), seedGetter }` from the
stable client bootstrap as `config`. The provider calls `initializeCoco()`. Its config is
initial-only: intentionally remount with a new React `key` when changing Wallets, coordinating
teardown through the session owner.

If the app already owns an initialized Coco Session, pass `manager={coco}` instead of `config`.
The app retains responsibility for calling `dispose()` in that mode. Choose one ownership path
for a session.

## Bind UI to operations

Use `useSendOperation`, `useReceiveOperation`, `useMintOperation`, and `useMeltOperation` for their
respective flows. Each hook owns one local operation binding:

- `prepare(input)` creates and binds an operation. Once bound, call `execute()`, `cancel()`,
  `refresh()`, or the other supported follow-up actions without an operation ID.
- Render durable state from `currentOperation`. `executeResult` contains execute-specific data,
  including a send's Token object. Obtain `const coco = useManager()` at the top level of the
  component and encode the returned token with `coco.wallet.encodeToken(token)`.
- `isLoading`, `status`, and `error` describe the local async action, not settlement. Disable
  conflicting buttons while loading and catch rejected action promises in event handlers.
- For a resume screen, pass the persisted operation or ID as the initial hook argument. That
  argument is initial-only; remount with a new key to switch operations.
- `reset()` clears the local binding. Cancel an eligible prepared operation through its action
  before resetting when the user intends to abandon it; resetting alone leaves durable work.

Create mint/melt quotes through `useManager().quotes`, then pass the quote to the operation
hook's `prepare()`. The hooks observe operation events; app-level polling is unnecessary for
ordinary state updates.

Use `useMints()` / `useTrustedMints()` for mint selection, `useBalances()` / `useTrustedBalance()`
for structured balance snapshots, and `usePaginatedHistory()` for history. `CocoCashuProvider`
composes their providers. For multi-unit views, check the installed hooks' unit support and use
the core unit-aware balance queries where needed.

Consult [Providers](https://cashubtc.github.io/coco/pages/react-providers) for custom composition
and [Hooks](https://cashubtc.github.io/coco/pages/react-hooks) for individual action contracts.
