---
name: coco-browser-wallet
description: Integrate Coco wallets into browser apps. Use for IndexedDB persistence, client-only session lifecycle, tab coordination, or Coco React providers and hooks.
---

# Coco wallets in the browser

## Load the shared workflow

Before implementing, load `coco-wallet` for Wallet identity, public APIs, mint trust, amounts,
wallet flows, Operation Recovery, and common verification. Resolve it through the agent's installed
skill catalog or its [sibling entry point](../coco-wallet/SKILL.md). If already loaded, continue
that workflow with the browser requirements below.

Install both skills from the same Coco revision. If `coco-wallet` is missing, obtain its complete
`skills/coco-wallet/` folder, including references, from that revision before implementing wallet
behavior. A reference to another skill does not install it automatically.

## Browser packages and bootstrap

Use `@cashu/coco-indexeddb` as the persistent adapter. Add `@cashu/coco-react` for React apps and
check its React peer range before installing. Keep the framework's existing client entry point.

Initialize from a client-only bootstrap after the wallet is unlocked. Keep IndexedDB, seed access,
and the Coco Session out of server rendering and server request handlers.

```ts
import { initializeCoco } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';

export async function openBrowserWallet(
  databaseName: string,
  seedGetter: () => Promise<Uint8Array>,
) {
  const repo = new IndexedDbRepositories({ name: databaseName });
  return initializeCoco({ repo, seedGetter });
}
```

The database name selects this Wallet's IndexedDB database. Browser WebSocket support is detected
by Coco automatically.

**Done when:** browser entry points use the selected adapter, and server rendering can run without
accessing browser storage or creating a Coco Session.

## Browser ownership and seed access

Use the shared workflow's session owner across navigation and framework remounts. Choose one
owning browser tab or implement explicit coordination; Coco events alone do not synchronize
another tab's UI.

Keep seed and bearer-token values out of URLs and server props. `localStorageSeedGetter()` from
`@cashu/coco-react` is an opt-in demo helper, unsuitable for real funds. It requires Web Locks in
a secure browser context and does not create a mnemonic backup.

For React lifecycle and hook wiring, read [React integration](references/react.md).

**Done when:** remounts and wallet switching follow the shared disposal rules, and the selected tab
policy controls which context can operate the Wallet.

## Browser verification

Alongside the shared wallet checks, exercise browser-specific behavior:

- Reload reopens the intended IndexedDB database; denied or unavailable storage surfaces an error.
- Initialization and teardown work under the framework's development remount behavior.
- A second tab follows the chosen ownership policy and refreshes any displayed wallet state.
- For apps with server rendering, the server build and render do not access browser-only APIs.

**Done when:** the browser checks and shared wallet checks pass for the requested flows, with any
untested browser or live-mint behavior identified in the handoff.
