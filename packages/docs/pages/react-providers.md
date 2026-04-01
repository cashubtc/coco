# Providers and Contexts

All hooks in `@cashu/coco-react` depend on React context providers. You can use
the `CocoCashuProvider` convenience wrapper or compose providers individually.

## CocoCashuProvider

Wraps `ManagerProvider`, `MintProvider`, and `BalanceProvider` in the correct
order.

```tsx
import { CocoCashuProvider } from '@cashu/coco-react';

<CocoCashuProvider manager={manager}>{children}</CocoCashuProvider>;
```

## ManagerProvider and ManagerGate

`ManagerProvider` exposes the `Manager` instance. `ManagerGate` is a helper that
only renders children when the manager is ready. The four operation hooks only
require `ManagerProvider`. `MintProvider` and `BalanceProvider` are for
derived-data hooks and require `ManagerProvider` to be above them in the tree.

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

Tracks total and per-mint balances. It refreshes automatically on
`proofs:saved`, `proofs:state-changed`, and `mint:updated` events.

```tsx
import { BalanceProvider, useBalanceContext } from '@cashu/coco-react';

<BalanceProvider>
  <BalanceWidget />
</BalanceProvider>;

const { balance } = useBalanceContext();
```

`useBalanceContext()` returns a `balance` object keyed by mint URL plus a
`total` field.
