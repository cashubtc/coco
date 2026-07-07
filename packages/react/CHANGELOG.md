# @cashu/coco-react

## 2.0.0-rc.1

### Patch Changes

- Updated dependencies [af4b491]
- Updated dependencies [5598750]
- Updated dependencies [d787fa1]
  - @cashu/coco-core@2.0.0-rc.1

## 2.0.0-rc.0

### Major Changes

- b910b5f: Migrate Coco to `@cashu/cashu-ts` v4 and native `Amount` semantics.

  Public APIs now accept `AmountLike` inputs where callers provide monetary values
  and return upstream `Amount` instances for balances, operation amounts, fees,
  history entries, and proofs. Persistent adapters store amount columns as
  canonical decimal strings and include migrations that preserve old numeric rows.
  Operation method metadata serializes BigInt values as decimal strings so
  AmountLike method fields remain persistable across adapters, while known amount
  metadata is rehydrated as upstream `Amount` values on operation reads.

  Packages that depend on `cashu-ts` are now ESM-only. CommonJS export entries and
  CJS build outputs were removed, and token encoding now follows the v4 cashu-ts
  API without explicit token-version selection.

- f9db334: Add first-class custom Cashu unit support across core APIs, React balance hooks,
  operation recovery, and storage adapters.

  Bare amount inputs continue to default to sats, while object-form amount inputs
  carry an explicit unit. Proofs, balances, quotes, operations, history, tokens,
  restore/sweep flows, and adapter persistence now preserve normalized unit
  metadata, with migrations and contract tests covering legacy sat fallback and
  custom-unit rows.

- 71993c2: Refactor melt operation prepare to accept `{ quote }` for BOLT quotes and `{ quote, feeIndex }` for onchain quotes, deriving method data from stored canonical melt quote state.
- 5e78860: Refactor mint operation prepare to accept `{ quote, amount }`, deriving method and unit data from the stored canonical mint quote.
- 6b8a896: Move mint quote import to `manager.quotes.mint.import(...)` and remove
  `manager.ops.mint.importQuote(...)`.

  Mint quote import now only updates canonical quote state and emits
  `mint-quote:updated` when a quote is created/imported or remote settlement state
  changes. Mint operations no longer mirror mutable quote remote state; callers
  should read quote state from `manager.quotes.mint.get(...)` or quote events and
  call `manager.ops.mint.prepare(...)` when they want an operation/history entry.

- 00ed073: Project history entries from operation repositories instead of maintaining a
  mutable history table.

  History entries now use deterministic `type:operationId` ids for operation
  rows, expose `source`, `updatedAt`, and `operationId` on operation-backed
  entries, and retain legacy table rows behind `legacy:*` ids for migration
  compatibility. The old history repository mutation contract has been removed;
  persistent adapters now read history by merging operation rows with legacy rows
  and de-duplicating legacy records that map to an operation.

- e6876ae: Update operation hooks for quote identity query APIs and remove the mint operation
  `getByQuote` hook helper.

### Minor Changes

- 0d89b94: Allow `CocoCashuProvider` to initialize Coco from a `CocoConfig` on initial
  mount, with loading and error fallbacks, while preserving the existing
  initialized-manager provider path. Add `localStorageSeedGetter()` as a browser
  localStorage-backed seed getter helper for React applications.

### Patch Changes

- b2ffef1: Add BOLT12 mint and melt operation support, including duplicate quote-id safe persistence.
- 2601aee: Remove outdated prerelease warning text from the published package READMEs.
- 0e25ddc: Make `Manager.dispose()` stop manager-owned watchers, processors, subscriptions, and plugin
  resources, and let the React provider rely on core disposal directly.
- Updated dependencies [b2ffef1]
- Updated dependencies [1dfdebf]
- Updated dependencies [3ba8af3]
- Updated dependencies [2601aee]
- Updated dependencies [0e25ddc]
- Updated dependencies [b910b5f]
- Updated dependencies [a8e029e]
- Updated dependencies [e6c780a]
- Updated dependencies [f9db334]
- Updated dependencies [0a2a8ce]
- Updated dependencies [203ebf4]
- Updated dependencies [34c16d3]
- Updated dependencies [71993c2]
- Updated dependencies [eefce1c]
- Updated dependencies [ab0fd42]
- Updated dependencies [e45cef2]
- Updated dependencies [167dec6]
- Updated dependencies [5e78860]
- Updated dependencies [6b8a896]
- Updated dependencies [737b993]
- Updated dependencies [d76264c]
- Updated dependencies [ab8be2d]
- Updated dependencies [9275ab7]
- Updated dependencies [a7c49ff]
- Updated dependencies [fe8ef00]
- Updated dependencies [00ed073]
- Updated dependencies [703a1b4]
- Updated dependencies [9342e56]
- Updated dependencies [c0e8d4f]
- Updated dependencies [16fc82c]
- Updated dependencies [06deb29]
- Updated dependencies [c8cee3c]
- Updated dependencies [0aa9a9f]
- Updated dependencies [9dd896d]
- Updated dependencies [9dc7be3]
- Updated dependencies [d25551a]
- Updated dependencies [fe4b820]
- Updated dependencies [ad67dbe]
- Updated dependencies [616f7f9]
- Updated dependencies [c489ac4]
- Updated dependencies [807ae19]
  - @cashu/coco-core@2.0.0-rc.0

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
