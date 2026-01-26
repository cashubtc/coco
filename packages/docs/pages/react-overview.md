# React Overview

The `coco-cashu-react` package provides React providers and hooks around a Coco `Manager` so UI code can access balance, mints, history, and send/receive flows.

## Installation

```sh
npm i coco-cashu-react coco-cashu-core
```

`react` is a peer dependency. Make sure your app is using React 19.

## Setup

Create a `Manager` with `coco-cashu-core`, then pass it to the provider. If your manager is created asynchronously, render a loading state until you have a `Manager` instance, then render the provider.

```tsx
import { useEffect, useState } from 'react';
import type { Manager } from 'coco-cashu-core';
import { initializeCoco } from 'coco-cashu-core';
import { CocoCashuProvider } from 'coco-cashu-react';

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

`CocoCashuProvider` is a convenience wrapper that composes `ManagerProvider`, `MintProvider`, and `BalanceProvider`.
