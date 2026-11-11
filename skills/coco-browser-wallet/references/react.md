# React integration

Use `@cashu/coco-react` with compatible core and React peer versions. Place the provider in a
client-only wallet subtree after unlock. Keep the repository and seed getter stable for that
Wallet's lifetime.

## Choose the session owner

Let the provider own initialization and disposal when the React subtree owns the session:

```tsx
import { CocoInitializationError, type CocoConfig } from '@cashu/coco-core';
import { CocoCashuProvider } from '@cashu/coco-react';
import type { ReactNode } from 'react';

export function WalletRoot({ config, children }: { config: CocoConfig; children: ReactNode }) {
  return (
    <CocoCashuProvider
      config={config}
      fallback={<p>Opening wallet…</p>}
      errorFallback={(error) => (
        <p>
          {error instanceof CocoInitializationError && error.cleanupState === 'unconfirmed'
            ? 'Wallet cleanup is incomplete. End the previous runtime before reopening this wallet.'
            : 'Could not open this wallet. Resolve the reported error before retrying.'}
        </p>
      )}
    >
      {children}
    </CocoCashuProvider>
  );
}
```

Pass `{ repo: new IndexedDbRepositories({ name: walletDatabaseName }), seedGetter }` from the
stable client bootstrap as `config`. The provider calls `initializeCoco()`. Its config is
initial-only: intentionally remount with a new React `key` when changing Wallets, coordinating
teardown through the session owner.

The error fallback does not retry initialization. Apply the shared skill's cleanup-state rules
before offering a remount/retry action, and surface the error through the app's diagnostic UI
without exposing wallet secrets. Provider unmount starts asynchronous disposal but exposes no
awaitable teardown handle. When switching Wallets or closing IndexedDB requires confirmed teardown,
use the app-owned session path below so the owner can await `dispose()` before closing the database.

If the app already owns an initialized Coco Session, pass `manager={coco}` instead of `config`.
The app retains responsibility for calling `dispose()` in that mode. Choose one ownership path
for a session.

## Choose a hook

`CocoCashuProvider` supplies the manager, mint, and balance providers used below. For custom
composition, load the [Providers guide](https://cashubtc.github.io/coco/pages/react-providers).

| Need                                                       | Hook                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Access the core APIs on the existing session               | `useManager()`                                                                          |
| List Known Mints and manage trust                          | `useMints()`                                                                            |
| List Trusted Mints and manage trust                        | `useTrustedMints()`                                                                     |
| Query balances with optional mint, unit, and trust filters | `useBalances(scope?)`                                                                   |
| Query balances for Trusted Mints                           | `useTrustedBalance()`                                                                   |
| Read the balance provider's existing snapshot              | `useBalanceContext()`                                                                   |
| Browse history by page or load more                        | `usePaginatedHistory(pageSize?)`                                                        |
| Bind an ecash send or receive                              | `useSendOperation(initialOperationOrId?)`, `useReceiveOperation(initialOperationOrId?)` |
| Bind a quote-backed mint or melt                           | `useMintOperation(initialOperationOrId?)`, `useMeltOperation(initialOperationOrId?)`    |

`useBalanceContext()` consumes the provider's snapshot; `useBalances(scope?)` owns a separate
query/subscription and returns a `refresh()` action. Use the scoped hook when the view needs its
own filters. Consult [Hooks](https://cashubtc.github.io/coco/pages/react-hooks) and the installed
declarations for individual return values and action signatures.

## Bind UI to operations

Use `useSendOperation`, `useReceiveOperation`, `useMintOperation`, and `useMeltOperation` for their
respective flows. Each hook owns one local operation binding:

- `prepare(input)` creates and binds an operation. Once bound, call `execute()`, `cancel()`,
  `refresh()`, or the other supported follow-up actions without an operation ID.
- Render durable state from `currentOperation`. `executeResult` contains execute-specific data,
  including a send's Token object. Obtain `const coco = useManager()` at the top level of the
  component and encode the returned token with `coco.wallet.encodeToken(token)`.
- `isLoading`, `status`, and `error` describe the local async action, not settlement. Disable
  conflicting buttons while loading and catch rejected action promises in event handlers.
- For a resume screen, pass the persisted operation or ID as the initial hook argument. That
  argument is initial-only; remount with a new key to switch operations.
  For a resumed send, check `currentOperation?.state === 'pending'` and that
  `currentOperation.token` exists before encoding it with `coco.wallet.encodeToken()` for delivery.
  `executeResult` is local hook state and is not restored after reload. The persisted token is the
  canonical copy for P2PK sends.
- `reset()` clears the local binding. Cancel an eligible prepared operation through its action
  before resetting when the user intends to abandon it; resetting alone leaves durable work.

The operation hooks observe operation events; app-level polling is unnecessary for ordinary
state updates.

## Use core APIs for flows without dedicated hooks

Call `const coco = useManager()` at the top level of the component, then use that session from
event handlers or effects. These flows have no dedicated React hooks; apply their shared guidance:

- `coco.quotes` for quote creation, import, lookup, listing, and refresh. Read
  [Shared mint and melt lifecycle](../../coco-wallet/references/quote-operations.md), then pass a
  quote to `useMintOperation().prepare()` or `useMeltOperation().prepare()` through the hook
  instance already created at the component's top level.
- `coco.auth` for [Mint authentication](../../coco-wallet/references/auth.md).
- `coco.wallet.restore()` and `coco.wallet.sweep()` for
  [Restore](../../coco-wallet/references/restore.md) and [Sweep](../../coco-wallet/references/sweep.md).
- `coco.paymentRequests` for [Payment requests](../../coco-wallet/references/payment-requests.md).
- `coco.keyring` for spending-key management described in [P2PK](../../coco-wallet/references/p2pk.md).
  Locked sends and receives still use the ordinary operation hooks.

Own loading/error state and relevant event subscriptions for these direct API calls. Reading
`useManager()` alone does not subscribe the component to their results. Reuse the shared skill's
reconciliation and cleanup rules.

## Render balances by unit

`useBalances(scope?)` accepts `mintUrls`, `units`, and `trustedOnly`. Its `balances` include
`byMintAndUnit[mintUrl][unit]` for mint-specific rows and `totalByUnit[unit]` for totals per unit.
For example, within a component:

```tsx
import { useBalances } from '@cashu/coco-react';

export function UnitBalances({ mintUrl }: { mintUrl: string }) {
  const { balances } = useBalances({
    mintUrls: [mintUrl],
    units: ['sat', 'usd'],
    trustedOnly: true,
  });
  return (
    <ul>
      {Object.entries(balances.totalByUnit).map(([unit, balance]) => (
        <li key={unit}>
          {balance.spendable.toString()} {unit}
        </li>
      ))}
    </ul>
  );
}
```

Omit `units` to load all units into the unit-indexed views. The convenience `byMint` and `total`
views default to sats; with one explicit unit they use that unit. With multiple explicit units,
`byMint` is empty and `total` is a zero sat placeholder: render the unit-indexed views instead.
Each snapshot exposes `spendable`, `reserved`, and `total` as `Amount` values. Display amounts with
`.toString()` and keep units separate rather than summing them together.

`useTrustedBalance()` applies `{ trustedOnly: true }` and returns the same structured shape;
use `useBalances({ trustedOnly: true, units: [...] })` when explicit unit filters are needed.
