# @cashu/coco-react

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [dabef01]
- Updated dependencies [505e1af]
  - @cashu/coco-core@1.0.0-rc.3

## 1.0.0-rc.1

### Patch Changes

- 2df62d5: Replace the legacy `useSend` and `useReceive` React hooks with operation-based
  hooks that mirror `manager.ops.*`.

  This change adds `useSendOperation`, `useReceiveOperation`, `useMintOperation`,
  and `useMeltOperation`, all of which expose durable `currentOperation` state,
  `executeResult`, optional initial binding from an operation or operation id,
  and bound lifecycle methods such as `load()`, `refresh()`, and `execute()`.

  The new hooks remove the older callback-style action options in favor of
  promise-returning methods plus hook-managed `status` and `error` state.

- 2df62d5: Document the React package's operation-oriented API more clearly.

  This updates the React README and docs to explain:
  - the `useSendOperation()`, `useReceiveOperation()`, `useMintOperation()`, and
    `useMeltOperation()` hooks
  - how `currentOperation`, `executeResult`, `load()`, and bound follow-up
    methods work
  - which providers are required for operation hooks versus derived-data hooks
  - how to migrate from the removed `useSend()` and `useReceive()` APIs

- a57cb82: Add structured wallet balance APIs across the core and React packages.

  Core now exposes canonical balance snapshots with spendable, reserved, and
  total amounts via `manager.wallet.balances.byMint()` and
  `manager.wallet.balances.total()`, along with new query/types support such as
  `BalanceQuery`, `BalanceSnapshot`, and `BalancesByMint`.

  React now exports `useBalances()` for the same structured balance data. The
  existing `useTrustedBalance()` and `useBalanceContext()` APIs now return
  structured `balances` data instead of the previous flat numeric balance map.

- Updated dependencies [a57cb82]
  - @cashu/coco-core@1.0.0-rc.1

## 1.0.0-rc.0

- Initial RC release under the `@cashu` namespace.
- Legacy changelog: `../../history/changelogs/legacy/react.md`
