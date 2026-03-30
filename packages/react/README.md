# @cashu/coco-react

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

React hooks and providers for integrating a Coco `Manager` into React
applications.

## Install

```bash
npm install @cashu/coco-react @cashu/coco-core react
```

## Usage

```tsx
import type { Manager } from '@cashu/coco-core';
import { CocoCashuProvider } from '@cashu/coco-react';

export function App({ manager }: { manager: Manager }) {
  return <CocoCashuProvider manager={manager}>{/* app */}</CocoCashuProvider>;
}
```

See the docs in `packages/docs` for hook and provider usage details.
