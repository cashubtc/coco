# Providers and Contexts

All hooks in `@cashu/coco-react` depend on React context providers. You can use
the `CocoCashuProvider` convenience wrapper or compose providers individually.

## CocoCashuProvider

Initializes Coco from config on initial mount, then wraps `ManagerProvider`,
`MintProvider`, and `BalanceProvider` in the correct order. Pass `fallback` for
the loading state and `errorFallback` for initialization failures.

```tsx
import { CocoCashuProvider } from '@cashu/coco-react';

<CocoCashuProvider
  config={{ repo, seedGetter }}
  fallback={<Spinner />}
  errorFallback={(error) => <InitError error={error} />}
>
  {children}
</CocoCashuProvider>;
```

The `config` prop is initial-only. To initialize with a different config,
remount the provider with a new React `key`.

For backwards compatibility or advanced lifecycle control, pass an initialized
manager instead:

```tsx
<CocoCashuProvider manager={manager}>{children}</CocoCashuProvider>
```

## ManagerProvider and ManagerGate

`ManagerProvider` exposes an already initialized `Manager` instance. It is the
low-level provider for custom provider composition and tests. `ManagerGate` is a
helper that only renders children when the manager is ready. The four operation
hooks only require `ManagerProvider`. `MintProvider` and `BalanceProvider` are
for derived-data hooks and require `ManagerProvider` to be above them in the
tree.

```tsx
import { ManagerProvider, ManagerGate, useManagerContext } from '@cashu/coco-react';

<ManagerProvider manager={manager}>
  <ManagerGate fallback={<Spinner />}>
    <Wallet />
  </ManagerGate>
</ManagerProvider>;

const { manager, ready, error, waitUntilReady } = useManagerContext();
```

If you just need the manager instance and want a strict check, use
`useManager()` which throws when the manager is not ready.

## MintProvider

Tracks all mints and trusted mints, and refreshes automatically on
`mint:added` and `mint:updated` events.

```tsx
import { MintProvider, useMints, useTrustedMints } from '@cashu/coco-react';

<MintProvider>
  <MintList />
</MintProvider>;

const { mints, trustedMints, addNewMint, trustMint, untrustMint, isTrustedMint } = useMints();
const { mints: trusted, trustMint: trust, untrustMint: untrust } = useTrustedMints();
```

## BalanceProvider

Tracks structured total and per-mint balances. It refreshes automatically on
`proofs:saved`, `proofs:state-changed`, `proofs:reserved`, and
`proofs:released` events.

```tsx
import { BalanceProvider, useBalanceContext } from '@cashu/coco-react';

<BalanceProvider>
  <BalanceWidget />
</BalanceProvider>;

const { balances } = useBalanceContext();
```

`useBalanceContext()` returns a `balances` object with:

- `byMint`: `{ [mintUrl]: { spendable, reserved, total } }`
- `total`: `{ spendable, reserved, total }`
