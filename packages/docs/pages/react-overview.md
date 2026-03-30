# React Overview

The `@cashu/coco-react` package provides React providers and hooks around a Coco `Manager` so UI code can access balance, mints, history, and send/receive flows.

In the core manager API, the canonical lifecycle surface now lives under `manager.ops.*`. The
React hooks keep their existing ergonomic names while building on the same underlying workflows.

## Installation

```sh
npm i @cashu/coco-react @cashu/coco-core
```

`react` is a peer dependency. Make sure your app is using React 19.

## Setup

Create a `Manager` with `@cashu/coco-core`, then pass it to the provider. If your manager is created asynchronously, render a loading state until you have a `Manager` instance, then render the provider.

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

`CocoCashuProvider` is a convenience wrapper that composes `ManagerProvider`, `MintProvider`, and `BalanceProvider`.
