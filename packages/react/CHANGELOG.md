# @cashu/coco-react

## 1.0.1

### Patch Changes

- Updated dependencies [28b7c8e]
- Updated dependencies [602c13c]
  - @cashu/coco-core@1.0.1

## 1.0.0

### Patch Changes

- 1daa3ce: Make React operation hooks reactive to manager events and simplify their binding
  lifecycle, while only persisting receive history once a receive is finalized.

  React operation hooks now stay bound to one operation for the lifetime of the
  hook instance, hydrate an initial `operationId` on mount, and update
  `currentOperation` from background operation events instead of requiring manual
  `load()` rebinding. The public `load()` method has been removed; if a mounted
  component needs to switch to a different operation, remount the hook or
  component with a new React `key`. This also guards against stale hydration
  results overwriting newer event-driven operation state.

  Core now records receive history only once a receive is finalized, instead of
  creating receive history entries during the prepared state. The legacy
  `receive:created` core event has also been removed.

- b662f28: Fix `useReceiveOperation` so it subscribes to manager events with a bound
  `Manager.on` call, preventing the hook from crashing when receive operation
  listeners are registered.

  Add a regression test that uses a `Manager.on` mock with real `this` semantics
  so detached invocation failures are caught in the React hook test suite.

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

- Updated dependencies [7f9cd39]
- Updated dependencies [dabef01]
- Updated dependencies [1daa3ce]
- Updated dependencies [dad73ba]
- Updated dependencies [3e6b339]
- Updated dependencies [660cb8e]
- Updated dependencies [505e1af]
- Updated dependencies [a57cb82]
  - @cashu/coco-core@1.0.0

## 1.0.0-rc.5

### Patch Changes

- b662f28: Fix `useReceiveOperation` so it subscribes to manager events with a bound
  `Manager.on` call, preventing the hook from crashing when receive operation
  listeners are registered.

  Add a regression test that uses a `Manager.on` mock with real `this` semantics
  so detached invocation failures are caught in the React hook test suite.
  - @cashu/coco-core@1.0.0-rc.5

## 1.0.0-rc.4

### Patch Changes

- 1daa3ce: Make React operation hooks reactive to manager events and simplify their binding
  lifecycle, while only persisting receive history once a receive is finalized.

  React operation hooks now stay bound to one operation for the lifetime of the
  hook instance, hydrate an initial `operationId` on mount, and update
  `currentOperation` from background operation events instead of requiring manual
  `load()` rebinding. The public `load()` method has been removed; if a mounted
  component needs to switch to a different operation, remount the hook or
  component with a new React `key`. This also guards against stale hydration
  results overwriting newer event-driven operation state.

  Core now records receive history only once a receive is finalized, instead of
  creating receive history entries during the prepared state. The legacy
  `receive:created` core event has also been removed.

- Updated dependencies [7f9cd39]
- Updated dependencies [1daa3ce]
- Updated dependencies [660cb8e]
  - @cashu/coco-core@1.0.0-rc.4

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
