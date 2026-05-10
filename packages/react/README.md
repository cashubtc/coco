# @cashu/coco-react

> ⚠️ Release candidate: Coco is stabilizing for v1, but breaking changes may
> still land before the final 1.0 release. Pin versions in production.

React hooks and providers for integrating a Coco `Manager` into React
applications.

The package exports the `CocoCashuProvider` convenience wrapper, which can
initialize Coco from config or accept an existing manager, the underlying
providers, operation-oriented hooks such as `useSendOperation`,
`useReceiveOperation`, `useMintOperation`, and `useMeltOperation`, plus
derived-data hooks such as `usePaginatedHistory`, `useBalances`, and
`useTrustedBalance`.

## Install

```bash
npm install @cashu/coco-react @cashu/coco-core react
```

`react` is a peer dependency. The current package peer range targets React 19.

## Usage

```tsx
import { CocoCashuProvider, localStorageSeedGetter, useSendOperation } from '@cashu/coco-react';

const seedGetter = localStorageSeedGetter();

function SendButton() {
  const { prepare, execute, currentOperation, executeResult, isLoading } = useSendOperation();
  const awaitingConfirmation = currentOperation?.state === 'prepared';

  async function handleSend() {
    if (awaitingConfirmation) {
      await execute();
      return;
    }

    await prepare({ mintUrl: 'https://mint.example', amount: 100 });
  }

  return (
    <button disabled={isLoading} onClick={() => void handleSend()}>
      {awaitingConfirmation ? 'Confirm send' : executeResult ? 'Sent' : 'Prepare send'}
    </button>
  );
}

export function App() {
  return (
    <CocoCashuProvider
      config={{ repo, seedGetter }}
      fallback={<div>Loading wallet...</div>}
      errorFallback={<div>Wallet failed to load.</div>}
    >
      <SendButton />
    </CocoCashuProvider>
  );
}
```

`localStorageSeedGetter()` stores a generated browser seed under
`COCO_REACT_SEED` by default. Pass `localStorageSeedGetter({ storageKey })` to
use a different localStorage key.

If your application already owns the manager lifecycle, pass an initialized
manager instead:

```tsx
<CocoCashuProvider manager={manager}>
  <SendButton />
</CocoCashuProvider>
```

The `config` prop is initial-only. Remount the provider with a new React `key`
when you intentionally need to initialize with a different config.

Each operation hook stays bound to one local operation flow for the lifetime of
that hook instance. It starts unbound until you call the hook's creation action
such as `prepare()`, and you can also initialize it from an existing operation
or operation id for resume screens. That initial hook argument is only used on
the first render; if a mounted component needs to switch to a different
operation, remount the hook or component with a new React `key`.

See the docs in `packages/docs` for provider composition and hook usage details.
