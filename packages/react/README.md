# @cashu/coco-react

> ⚠️ Release candidate: the React API is stabilizing for v1, but breaking
> changes may still land before the final 1.0 release.

React hooks and providers for integrating a Coco `Manager` into React
applications.

The package exports the `CocoCashuProvider` convenience wrapper, the underlying
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
import type { Manager } from '@cashu/coco-core';
import { CocoCashuProvider, useSendOperation } from '@cashu/coco-react';

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

export function App({ manager }: { manager: Manager }) {
  return (
    <CocoCashuProvider manager={manager}>
      <SendButton />
    </CocoCashuProvider>
  );
}
```

Each operation hook stays bound to one local operation flow. It starts unbound
until you call `prepare()` or `load(operationId)`, and you can also initialize
it from an existing operation or operation id for resume screens. That initial
hook argument is only used on the first render; if a mounted component needs to
switch to a different operation, call `load(operationId)` explicitly.

See the docs in `packages/docs` for provider composition and hook usage details.
