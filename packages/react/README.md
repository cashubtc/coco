# @cashu/coco-react

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

React hooks and providers for integrating a Coco `Manager` into React
applications.

The package exports the `CocoCashuProvider` convenience wrapper, the underlying
providers, and hooks such as `useSend`, `useReceive`, `usePaginatedHistory`,
and `useTrustedBalance`.

## Install

```bash
npm install @cashu/coco-react @cashu/coco-core react
```

`react` is a peer dependency. The current package peer range targets React 19.

## Usage

```tsx
import type { Manager } from '@cashu/coco-core';
import { CocoCashuProvider } from '@cashu/coco-react';

export function App({ manager }: { manager: Manager }) {
  return <CocoCashuProvider manager={manager}>{/* app */}</CocoCashuProvider>;
}
```

See the docs in `packages/docs` for provider composition and hook usage details.
