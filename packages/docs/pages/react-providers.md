# Providers and Contexts

All hooks in `coco-cashu-react` depend on React context providers. You can use the `CocoCashuProvider` convenience wrapper or compose providers individually.

## CocoCashuProvider

Wraps `ManagerProvider`, `MintProvider`, and `BalanceProvider` in the correct order.

```tsx
import { CocoCashuProvider } from 'coco-cashu-react';

<CocoCashuProvider manager={manager}>{children}</CocoCashuProvider>;
```

## ManagerProvider and ManagerGate

`ManagerProvider` exposes the `Manager` instance. `ManagerGate` is a helper that only renders children when the manager is ready. `MintProvider` and `BalanceProvider` require `ManagerProvider` to be above them in the tree.

```tsx
import { ManagerProvider, ManagerGate, useManagerContext } from 'coco-cashu-react';

<ManagerProvider manager={manager}>
  <ManagerGate fallback={<Spinner />}>
    <Wallet />
  </ManagerGate>
</ManagerProvider>;

const { manager, ready, error, waitUntilReady } = useManagerContext();
```

If you just need the manager instance and want a strict check, use `useManager()` which throws when the manager is not ready.

## MintProvider

Tracks all mints and trusted mints, and refreshes automatically on `mint:added` and `mint:updated` events.

```tsx
import { MintProvider, useMints, useTrustedMints } from 'coco-cashu-react';

<MintProvider>
  <MintList />
</MintProvider>;

const { mints, trustedMints, addNewMint, trustMint, untrustMint, isTrustedMint } = useMints();
const { mints: trusted, trustMint: trust, untrustMint: untrust } = useTrustedMints();
```

## BalanceProvider

Tracks total and per-mint balances. It refreshes automatically on `proofs:saved`, `proofs:state-changed`, and `mint:updated` events.

```tsx
import { BalanceProvider, useBalanceContext } from 'coco-cashu-react';

<BalanceProvider>
  <BalanceWidget />
</BalanceProvider>;

const { balance } = useBalanceContext();
```

`useBalanceContext()` returns a `balance` object keyed by mint URL plus a `total` field.
