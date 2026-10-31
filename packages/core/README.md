# @cashu/coco-core

Modular, storage-agnostic core for working with Cashu mints and wallets.

- **Storage-agnostic**: Repositories are interfaces; bring your own persistence.
- **Typed Event Bus**: Subscribe to mint, proof, quote, and counter events with strong types.
- **High-level APIs**: `MintApi`, `WalletApi`, `AuthApi`, `PaymentRequestsApi`,
  `QuoteApi`, `HistoryApi`, `KeyRingApi`, and `manager.ops.*` for common flows.
- **Background watchers**: Optional services to track quote/payment and proof states.

## Install

```bash
npm install @cashu/coco-core
```

For a real application you will usually install a storage adapter alongside the
core package, for example `@cashu/coco-sqlite`, `@cashu/coco-indexeddb`, or
`@cashu/coco-expo-sqlite`. Bun applications can use `@cashu/coco-sqlite-bun`.

## Entry points

`@cashu/coco-core` publishes three documented import surfaces. Pick the narrowest
one that matches what you are building:

```ts
// App and React usage
import { initializeCoco, Amount, type Manager } from '@cashu/coco-core';

// Storage adapter implementations and adapter contract tests
import { type Repositories, serializeAmount } from '@cashu/coco-core/adapter';

// Plugin authors
import type { Plugin, PluginExtensions } from '@cashu/coco-core/plugin';
```

- Use the package root for app-facing wallet setup, manager APIs, public models,
  errors, amount helpers, events, logging, and config boundary types.
- Use `@cashu/coco-core/adapter` when you are writing persistence adapters or
  adapter contract tests. Repository contracts, persisted operation/domain
  shapes, and serialization helpers live there.
- Use `@cashu/coco-core/plugin` when you are writing extensions. Plugin
  lifecycle types, extension augmentation types, plugin service keys, and plugin
  errors live there.

Concrete services, operation service classes, handler providers, transport
internals, `PluginHost`, and individual memory repository classes are
implementation details. They are not app-facing root API.

## Repository compatibility

Starting with **v3**, the repository implementation contract is a public, **unstable** extension
point. This policy does not apply retroactively to v2. Custom storage adapters remain supported:
implement `Repositories` from `@cashu/coco-core/adapter`, initialize your adapter, and pass it as
`repo` to `initializeCoco({ repo, seedGetter })`. This includes backends beyond the supplied
adapters, such as an independently implemented PostgreSQL adapter.

The unstable contract includes the `Repositories` aggregate, individual repository interfaces and
methods, transaction-scope interfaces, and types or helpers used exclusively to implement
repositories. These may change incompatibly in **minor or major releases**. **Patch releases must
preserve compatibility** with this contract. Every incompatible change must include an adapter
migration note explaining the affected interfaces, required implementation changes, and any
persistence migration needed.

This exception is scoped by the contract, not by the import path. Shared public domain models
(such as `CoreProof`), Wallet APIs, events, and plugin service interfaces retain normal semantic
versioning guarantees even when repositories reference them or `/adapter` re-exports them. Their
incompatible changes require a major release. The supplied adapters' constructors, configuration,
initialization, and normal use through `initializeCoco` retain those guarantees too. Direct use
of their repository methods follows the unstable repository contract.

Adapter authors should declare the Coco versions they support and run the relevant
[`@cashu/coco-adapter-tests` conformance suites](../adapter-tests/README.md) against their actual
backend before expanding that range. Do not assume compatibility with future minor releases; for
example, an adapter validated for the 3.2 release line can declare `>=3.2.0 <3.3.0` rather than
`^3.2.0`. Use matching releases of core and the conformance package when validating an upgrade.

Unstable signatures do not relax transaction, durability, or recovery requirements. Adapters must
continue to satisfy the documented repository semantics. Compatibility with persisted wallet data
is assessed separately; changing an interface does not by itself permit dropping existing data or
operation recovery support.

See [ADR-0013](docs/adr/0013-keep-custom-adapters-with-scoped-compatibility.md) for the rationale.

## Mint Swap operations

Mint Swap moves an exact sat amount between two distinct trusted mints using BOLT11. Its API is
available without feature configuration:

```ts
const manager = await initializeCoco({
  repo: repos,
  seedGetter,
});
const operation = await manager.ops.mintSwap.prepare({
  id: 'caller-stable-swap-id',
  sourceMintUrl: 'https://source.example',
  destinationMintUrl: 'https://destination.example',
  destinationAmount: { amount: 100, unit: 'sat' },
  sourceDebitCap: { amount: 110, unit: 'sat' },
});
// Inspect operation.state and, when prepared, its sourceDebitBounds before approving payment.
if (operation.state === 'prepared') await manager.ops.mintSwap.execute(operation.id);
const outcome = await manager.ops.mintSwap.waitForOutcome(operation.id, { timeoutMs: 30_000 });
```

The persisted operation is authoritative. Reusing an ID requires the same normalized intent.
Preparation does not pay; `execute` explicitly authorizes the initial source payment. `get` and
`listActive` read locally. `refresh(id)` and `recovery.run()` reconcile existing work, including
finishing persisted preparation, without paying an untouched prepared source. They may recover
already-authorized source work and redeem funded destination value.

Coco packages are intended to be used with lock-step versioning; Mint Swap has no separate API
activation flag. Automatic parent recovery is enabled by default. To use only explicit parent
recovery, set `processors.mintSwapOperationProcessor.disabled: true`. That skips automatic parent
startup/resume passes and timers while keeping preparation, execution, reads, cancellation and
explicit recovery available. Ordinary Mint/Melt recovery retains its own configuration.
The processor options `processIntervalMs` (1000), `sweepIntervalMs` (30000) and `batchSize` (25)
control scanning, not persisted retry/backoff policy. The processor registers parent-owned quote
interests with the existing Mint/Melt watchers, including parents whose recovery deadline is still
in the future. Watchers commit canonical quote observations; the parent then coordinates eligible
recovery using those observations and shared child locks. Exact authorized recovery interests
remain observable after trust revocation without trusting the mint again.

Disabling a watcher stops ongoing observation, not parent coordination or explicit recovery.
Periodic parent scans do not replace a disabled watcher with quote polling. Bounded startup
recovery and explicit `refresh(id)` / `recovery.run()` can still make target-isolated checks;
automatic startup recovery respects processor configuration and persisted due times. Necessary
operation recovery effects remain available. Before releasing source inputs on `UNPAID`, recovery
requires fresh confirmation under the shared source child lock, whether or not a watcher is enabled.
If new routine quote evidence is needed, the parent remains recoverable until observation resumes
or a caller supplies it through refresh/recovery. Re-enabling watchers rebuilds parent interests
without resetting retry deadlines. Mint-provided Retry-After delays remain a lower bound on the next
automatic attempt.

`cancel(id)` records intent and returns the actual state. An ambiguous source can remain pending;
a paid source recovers forward. Cancellation can still incur a completed pre-swap fee. A
`needs_attention` outcome requires inspection and is not successful settlement. A waiter timeout
only ends observation; it never cancels, executes or recovers the swap. Waiters support `signal`
and `pollIntervalMs`, and reject on disposal, a missing operation or a read failure.
The timeout includes a final local read. Disposal drains admitted commands and pause/resume work
before completing.

`mint-swap:updated` carries `{ operationId, revision, state }` after commit and lock release.
Quote and metadata updates committed by a parent command are also published after its locks are
released, so listeners can await a refresh of that parent.
Hints can be lost, duplicated by application delivery, or arrive out of order; reload and retain
the newest revision. Waiters keep polling even without events. Lifecycle requests should be made
outside awaited operation or lifecycle event listeners, so a listener does not await shutdown of its own work.

Use one effect-driving Coco Session per Wallet store. Manager shares child locks with ordinary
Mint/Melt services; Core does not enforce a universal cross-process singleton. Reuse host session
guards (such as Cocod's state-directory lease); React initialization guards apply per provider.
Mint Swap exclusively coordinates its children while it is active: ordinary Mint/Melt commands that
would change a child or use its quote reject with `MintSwapChildOperationError`; pass its
`parentOperationId` to `ops.mintSwap`. Reads keep returning children. Once the parent is terminal or
`needs_attention`, its children return to ordinary resolution, but no ordinary command pays its
source (`parentStopped: true`). See [Mint Swap Operations](https://github.com/cashubtc/coco/blob/master/TRANSACTION_DESIGN.md#mint-swap-operations).
History projection and React Mint Swap hooks are outside this slice.

## Protocol Support

- [x] NUT-00
- [x] NUT-01
- [x] NUT-02
- [x] NUT-03
- [x] NUT-04
- [x] NUT-05
- [x] NUT-06
- [x] NUT-07
- [x] NUT-08
- [x] NUT-09
- [x] NUT-10
- [x] NUT-11
- [x] NUT-12
- [x] NUT-13
- [ ] NUT-14
- [ ] NUT-15
- [ ] NUT-16
- [x] NUT-17
- [x] NUT-18
- [ ] NUT-19
- [ ] NUT-20
- [x] NUT-21
- [x] NUT-22
- [x] NUT-23
- [ ] NUT-24
- [ ] NUT-25

## Quick start

```ts
import { initializeCoco, MemoryRepositories, ConsoleLogger } from '@cashu/coco-core';

// Provide a deterministic 64-byte seed for wallet key derivation
const seedGetter = async () => seed;

const repos = new MemoryRepositories();
const logger = new ConsoleLogger('example', { level: 'info' });

const manager = await initializeCoco({
  repo: repos,
  seedGetter,
  logger,
});

// Subscribe to events (typed)
const unsubscribe = manager.on('counter:updated', (c) => {
  console.log('counter updated', c);
});

// Register a mint
await manager.mint.addMint('https://nofees.testnut.cashu.space');

// Create a mint quote, prepare an operation, pay externally, then redeem
const quote = await manager.quotes.mint.create({
  mintUrl: 'https://nofees.testnut.cashu.space',
  amount: 100,
  method: 'bolt11',
});

const pendingMint = await manager.ops.mint.prepare({
  quote,
  amount: 100,
});

const completed = new Promise<void>((resolve, reject) => {
  let offFinalized = () => {};
  let offFailed = () => {};
  const cleanup = () => {
    offFinalized();
    offFailed();
  };

  offFinalized = manager.on('mint-op:finalized', ({ operationId }) => {
    if (operationId !== pendingMint.id) return;
    cleanup();
    resolve();
  });
  offFailed = manager.on('mint-op:failed', ({ operationId, operation }) => {
    if (operationId !== pendingMint.id) return;
    cleanup();
    reject(new Error(operation.terminalFailure?.reason ?? operation.error ?? 'Mint failed'));
  });
});

// pay pendingMint.request externally; default processors finalize after payment
await completed;

// Check balances
const balances = await manager.wallet.balances.byMint();
const total = await manager.wallet.balances.total();
console.log('balances', balances);
console.log('wallet total', total.total);

// Inspect spendable vs reserved funds explicitly when needed
console.log('spendable balance', balances['https://nofees.testnut.cashu.space']?.spendable ?? 0);
console.log('reserved balance', balances['https://nofees.testnut.cashu.space']?.reserved ?? 0);
```

### Watchers & processors (optional)

Start background watchers or processors to automatically react to changes:

```ts
// Watch mint operation quote updates on startup and while running (default true)
await manager.enableMintOperationWatcher({ watchExistingPendingOnStart: true });

// Process queued mint operations from live events (auto-enabled by initializeCoco)
await manager.enableMintOperationProcessor({ processIntervalMs: 3000 });

// Watch canonical melt quote updates and settle pending melt operations
await manager.enableMeltQuoteWatcher();
await manager.enableMeltSettlementProcessor();

// Watch proof state updates (e.g., to move inflight proofs to spent)
await manager.enableProofStateWatcher();

// Later, you can stop them
await manager.disableMintOperationWatcher();
await manager.disableMintOperationProcessor();
await manager.disableMeltQuoteWatcher();
await manager.disableMeltSettlementProcessor();
await manager.disableProofStateWatcher();
```

### initializeCoco options

`initializeCoco` sets up repositories, plugins, watchers, and processors for you. You can configure it via `CocoConfig`:

- `repo`: `Repositories` implementation (required)
- `seedGetter`: async seed provider (required)
- `logger`: optional logger (defaults to `NullLogger`)
- `webSocketFactory`: optional WebSocket factory
- `plugins`: optional plugin list
- `watchers`: enable/disable watcher services (`mintOperationWatcher`, `meltQuoteWatcher`,
  `proofStateWatcher`)
- `processors`: enable/disable processors (`mintOperationProcessor`, `meltSettlementProcessor`)
  and tune intervals
- `subscriptions`: polling intervals for hybrid WebSocket + polling (`slowPollingIntervalMs`, `fastPollingIntervalMs`)

If you prefer manual wiring, construct `Manager` directly and call `initPlugins()` before enabling watchers/processors.

## Architecture

- `Manager` is the app-facing facade. It exposes `mint`, `wallet`, `auth`,
  `quotes`, `paymentRequests`, `ops`, `history`, and `keyring` APIs plus watcher
  and processor helpers.
- `initializeCoco` wires the manager from a `CocoConfig`, including
  repositories, seed access, logging, subscriptions, plugins, watchers, and
  processors.
- `manager.ops.*` is the supported surface for recoverable send, receive, mint,
  and melt lifecycles.
- `manager.quotes.mint` and `manager.quotes.melt` expose canonical quote lookup,
  creation, and refresh workflows.
- `manager.on(...)` exposes typed `CoreEvents`, including subscription,
  operation, proof, quote, history, mint, and auth-session events.

### Storage

Initialize Coco with the built-in storage adapter for your runtime. The package root also exports
`MemoryRepositories` for in-memory tests and examples. See [Storage Adapters](../docs/pages/storage-adapters.md)
for setup and storage-security guidance.

## Public API surface

### Manager

- `mint`, `wallet`, `auth`, `quotes`, `paymentRequests`, `ops`, `history`, and
  `keyring`
- `ext: PluginExtensions` from `@cashu/coco-core/plugin`
- `on/once/off` for `CoreEvents`
- `enableMintOperationWatcher()`, `disableMintOperationWatcher()`
- `enableMintOperationProcessor()`, `disableMintOperationProcessor()`,
  `waitForMintOperationProcessor()`
- `enableMeltQuoteWatcher()`, `disableMeltQuoteWatcher()`
- `enableMeltSettlementProcessor()`, `disableMeltSettlementProcessor()`
- `enableProofStateWatcher()`, `disableProofStateWatcher()`
- `pauseSubscriptions()`, `resumeSubscriptions()`
- `use(plugin: Plugin): void` with `Plugin` from `@cashu/coco-core/plugin`
- `initPlugins(): Promise<void>`
- `dispose(): Promise<void>`

### OpsApi

- `send`: `prepare`, `execute`, `get`, `listPrepared`, `listInFlight`,
  `refresh`, `cancel`, `reclaim`, plus `recovery` and `diagnostics`
- `receive`: `prepare`, `execute`, `get`, `listPrepared`, `listInFlight`,
  `refresh`, `cancel`, plus `recovery` and `diagnostics`
- `mint`: `prepare`, `execute`, `get`, `listByQuote`,
  `listPending`, `listInFlight`, `checkPayment`, `refresh`, `finalize`, plus
  `recovery` and `diagnostics`. Built-in methods: `bolt11`, `onchain`,
  `bolt12`.
- `melt`: `prepare`, `execute`, `get`, `getByQuote`, `listByQuote`,
  `listPrepared`, `listInFlight`, `refresh`, `cancel`, `reclaim`, `finalize`,
  plus `recovery` and `diagnostics`. Built-in methods: `bolt11`, `bolt12`,
  `onchain`.

Lifecycle commands that target a missing Operation reject with `OperationNotFoundError`. A
command that is unavailable in the Operation's current state rejects with `OperationStateError`,
which carries `operationType`, `operationId`, the observed `state`, and the accepted
`expectedStates`. When a Melt Quote's state rather than the Operation's own state blocks the
command, such as reclaiming a Melt whose quote is `PAID`, it also carries `quoteState`. Re-read the
Operation before choosing another command. Send and Receive transitions that detect a concurrent
change under their operation lock still reject with `SendOperationConflictError` and
`ReceiveOperationConflictError`. Preparing an on-chain Melt with a missing or unknown fee option
rejects with `MeltQuoteValidationError`.

Mint and melt quote lookups use `QuoteIdentity`, the methodless object shape
`{ mintUrl, quoteId }`:

```ts
const mintIdentity = { mintUrl: mintQuote.mintUrl, quoteId: mintQuote.quoteId };

await manager.quotes.mint.get(mintIdentity);
await manager.quotes.mint.refresh(mintIdentity);
await manager.ops.mint.listByQuote(mintIdentity);

const meltIdentity = { mintUrl: meltQuote.mintUrl, quoteId: meltQuote.quoteId };

await manager.quotes.melt.get(meltIdentity);
await manager.quotes.melt.refresh(meltIdentity);
await manager.ops.melt.getByQuote(meltIdentity);
await manager.ops.melt.listByQuote(meltIdentity);
```

Operation preparation accepts structural quote refs. `MintQuoteRef` and
`MeltQuoteRef` are `{ mintUrl, quoteId, method }`, and full canonical quote
objects already satisfy those types. Mint prepare uses
`prepare({ quote, amount })`; BOLT melt prepare uses `prepare({ quote })`; and
onchain melt prepare uses `prepare({ quote, feeIndex })`. Public operation
prepare inputs do not accept sibling `unit`, `method`, or `methodData` fields;
those details are derived from canonical quote storage.

### MintApi

- `addMint(mintUrl: string, options?: { trusted?: boolean }): Promise<{ mint: Mint; keysets: Keyset[] }>`
- `getMintInfo(mintUrl: string): Promise<MintInfo>`
- `isTrustedMint(mintUrl: string): Promise<boolean>`
- `getAllMints(): Promise<Mint[]>`
- `getAllTrustedMints(): Promise<Mint[]>`
- `trustMint(mintUrl: string): Promise<void>`
- `untrustMint(mintUrl: string): Promise<void>`

Trust changes, including `addMint()` with a different `trusted` value for a Known Mint, commit
before Coco refreshes stale metadata. If that refresh fails, the trust change still succeeds and
publishes the stored metadata; only a mint with no stored metadata propagates the refresh failure.

### WalletApi

- `receive(token: Token | string): Promise<void>`
- `balances.byMint(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByMint>`
- `balances.byMintAndUnit(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByMintAndUnit>`
- `balances.byUnit(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByUnit>`
- `balances.total(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalanceSnapshot>`
- `balances.totalByUnit(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByUnit>`
- `restore(mintUrl: string, options?: { units?: string[] }): Promise<void>`
- `sweep(mintUrl: string, bip39seed: Uint8Array, options?: { units?: string[] }): Promise<SweepReport>`
- `decodeToken(tokenString: string, mintUrl?: string): Promise<Token>`
- `encodeToken(token: Token, opts?: { removeDleq?: boolean }): string`
- `encodePaymentRequest(paymentRequest: PaymentRequest, version?: 'creqA' | 'creqB'): string`

Sweep returns `{ mintUrl, keysets }`. Each keyset result identifies its `keysetId` and `unit`,
with status `transferred`, `noop`, `skipped`, `failed`, or `unresolved`. Pending observations are
reported as `pending: { count, amount }`; skips distinguish `pending` from `uneconomic`.
A transferred result includes `received`, `fee`, and `receiveOperationId`. All amounts are cashu-ts
`Amount` values in that result's unit. Discovery failures may have no pending observations.

Sweep returns the complete report even when all keysets fail or remain unresolved. Callers must
inspect every status; a resolved call does not imply a successful transfer. Input validation and
mint setup failures still reject before keyset processing.
Inspect unresolved Receive IDs through `ops.receive` before retrying. Receive owns
exchange recovery and ordinary Receive history; Sweep does not resume unvisited keysets after
restart or deduplicate a later sweep against unresolved exchanges. See the [Sweep guide](../docs/pages/bip39.md#sweep).

### AuthApi

- `startDeviceAuth(mintUrl: string)`
- `login(mintUrl, tokens): Promise<AuthSession>`
- `restore(mintUrl): Promise<boolean>`
- `logout(mintUrl): Promise<void>`
- `getSession(mintUrl): Promise<AuthSession>`
- `hasSession(mintUrl): Promise<boolean>`
- `getAuthProvider(mintUrl): AuthProvider | undefined`
- `getPoolSize(mintUrl): number`

### PaymentRequestsApi

- `parse(paymentRequest: string): Promise<ResolvedPaymentRequest>`
- `prepare(request: ResolvedPaymentRequest, options: { mintUrl: string; amount?: UnitAmountLike }): Promise<PreparedPaymentRequest>`
- `execute(transaction: PreparedPaymentRequest): Promise<PaymentRequestExecutionResult>`
- `incoming.create(input: CreateIncomingPaymentRequestInput): Promise<PaymentRequestReceiveOperation>`

### QuoteApi

- `mint.create(...)`, `mint.import(...)`, `mint.get({ mintUrl, quoteId })`
- `mint.listPending({ method? })`, `mint.refresh({ mintUrl, quoteId })`
- `melt.create(...)`, `melt.get({ mintUrl, quoteId })`
- `melt.listPending({ method? })`, `melt.refresh({ mintUrl, quoteId })`

Quote refreshes persist canonical quote snapshots before emitting
`mint-quote:updated` or `melt-quote:updated`. Use `manager.on(...)` for live
application flows and operation APIs when a mint or melt should be finalized.

### HistoryApi

- `getPaginatedHistory(offset?: number, limit?: number): Promise<HistoryEntry[]>`
- `getHistoryEntryById(id: string): Promise<HistoryEntry | null>`
- `getOperationIdForHistoryEntry(id: string): Promise<string | null>`

### KeyRingApi

- `generateKeyPair(dumpSecretKey?: boolean): Promise<{ publicKeyHex: string } | Keypair>`
- `addKeyPair(secretKey: Uint8Array): Promise<Keypair>`
- `removeKeyPair(publicKey: string): Promise<void>`
- `getKeyPair(publicKey: string): Promise<Keypair | null>`
- `getLatestKeyPair(): Promise<Keypair | null>`
- `getAllKeyPairs(): Promise<Keypair[]>`

### Subscriptions in Node vs browser

`Manager` will auto-detect a global `WebSocket` if available (e.g., browsers).
In non-browser environments, provide a `webSocketFactory` through
`initializeCoco` or `Manager` construction. App code should not need transport
internals.

## Core events

See the `CoreEvents` type for the full, current event map. Common events
include:

- `mint:added` → `{ mint, keysets }`
- `mint:updated` → `{ mint, keysets }`
- `mint:trusted` → `{ mintUrl }`
- `mint:untrusted` → `{ mintUrl }`
- `counter:updated` → `Counter`
- `proofs:saved` → `{ mintUrl, keysetId, proofs }`
- `proofs:state-changed` → `{ mintUrl, secrets, state }`
- `proofs:deleted` → `{ mintUrl, secrets }`
- `proofs:wiped` → `{ mintUrl, keysetId }`
- `proofs:reserved` → `{ mintUrl, operationId, secrets, amount }`
- `proofs:released` → `{ mintUrl, secrets }`
- `mint-quote:updated` → `{ mintUrl, method, quoteId, quote }`
- `melt-quote:updated` → `{ mintUrl, method, quoteId, quote }`
- `mint-op:pending` → `{ mintUrl, operationId, operation }`
- `mint-op:requeue` → `{ mintUrl, operationId, operation }`
- `mint-op:executing` → `{ mintUrl, operationId, operation }`
- `mint-op:finalized` → `{ mintUrl, operationId, operation }`
- `mint-op:failed` → `{ mintUrl, operationId, operation }`
- `send:prepared` → `{ mintUrl, operationId, operation }`
- `send:pending` → `{ mintUrl, operationId, operation, token }`
- `send:finalized` → `{ mintUrl, operationId, operation }`
- `send:rolled-back` → `{ mintUrl, operationId, operation }`
- `receive-op:prepared` → `{ mintUrl, operationId, operation }`
- `receive-op:finalized` → `{ mintUrl, operationId, operation }`
- `receive-op:rolled-back` → `{ mintUrl, operationId, operation }`
- `history:updated` → `{ mintUrl, entry }`
- `melt-op:prepared` → `{ mintUrl, operationId, operation }`
- `melt-op:pending` → `{ mintUrl, operationId, operation }`
- `melt-op:finalized` → `{ mintUrl, operationId, operation }`
- `melt-op:rolled-back` → `{ mintUrl, operationId, operation }`
- `subscriptions:paused` / `subscriptions:resumed`
- `auth-session:updated` / `auth-session:deleted` / `auth-session:expired`

## Plugins

### Overview

- **Purpose**: Extend the core by hooking into lifecycle events with access only to the services you declare.
- **Lifecycle hooks**: `onInit` (after services are created), `onReady` (after APIs are built), `onDispose` (on shutdown).
- **Cleanup**: `onInit` and `onReady` may return a cleanup function (sync or async). Return cleanup for resources acquired by the hook, such as subscriptions; hooks that acquire no resources can return nothing. `onDispose` may complete synchronously or asynchronously.

### Types

```ts
import type { Plugin, ServiceKey } from '@cashu/coco-core/plugin';

// Service keys are derived from the exported plugin ServiceMap type.
// Use ServiceKey when you want the current full set without duplicating it here.

const myPlugin: Plugin<['eventBus', 'logger']> = {
  name: 'my-plugin',
  required: ['eventBus', 'logger'] as const,
  onInit: ({ services: { eventBus, logger } }) => {
    const off = eventBus.on('mint:added', (p) => logger.info('mint added', p));
    return off;
  },
  onReady: async () => {
    // optional
  },
  onDispose: () => {
    // optional
  },
};
```

Plugins that ingest externally created mint quotes can request the canonical
quote API:

```ts
const quotePlugin: Plugin<['quotes']> = {
  name: 'quote-plugin',
  required: ['quotes'] as const,
  onReady: async ({ services }) => {
    await services.quotes.mint.import({
      mintUrl,
      method: 'bolt11',
      quote,
    });
  },
};
```

### Using plugins

```ts
// Pass plugins at construction
const manager = new Manager(repos, seedGetter, logger, undefined, [myPlugin]);

// Or register later
manager.use(myPlugin);

// Dispose (runs onDispose and registered cleanups)
await manager.dispose();
```

### Error handling

- Ordinary errors thrown in `onInit` or `onReady` are caught and logged to the console with the plugin name. Extension registration conflicts propagate as `ExtensionRegistrationError`.
- During plugin disposal, all `onDispose` hooks and registered cleanup functions are attempted. Failures are collected and disposal rejects with an `AggregateError`; `manager.dispose()` propagates that failure.

## Exports

From the package root (`@cashu/coco-core`), for app and React usage:

- `Manager`, `initializeCoco`, `CocoConfig`
- `MemoryRepositories`
- Public APIs including `MintApi`, `WalletApi`, `AuthApi`, `PaymentRequestsApi`,
  `QuoteApi`, and the operation-oriented APIs
- Public models, errors, API inputs/results, and operation result types
- Events: `CoreEvents`, `EventHandler`
- Types: `CoreProof`, `ProofState`, `BalanceQuery`, `BalanceSnapshot`,
  `BalancesByMint`, `BalanceBreakdown`, `BalancesBreakdownByMint`
- Logging: `ConsoleLogger`, `Logger`
- Helpers: `getEncodedToken`, `getDecodedToken`, `normalizeMintUrl`
- Amount/unit helpers and intentional `@cashu/cashu-ts` re-exports such as `Amount`
- Config boundary types: `WebSocketLike`, `WebSocketFactory`

From the adapter subpath (`@cashu/coco-core/adapter`), for storage adapter
implementations and adapter contract tests:

- Repository contracts, transaction scope types, persisted operation/domain types, and
  adapter serialization helpers for storage implementations

From the plugin subpath (`@cashu/coco-core/plugin`), for extension authors:

- Plugin author types: `Plugin`, `PluginContext`, `PluginExtensions`, `PluginEventBus`,
  `ServiceKey`, `ServiceMap`, `Cleanup`, `CleanupFn`
- Plugin errors: `DuplicatePluginRegistrationError`, `ExtensionRegistrationError`

The package root (`@cashu/coco-core`) is the supported public import path unless
`package.json` explicitly lists a subpath export. Documented public symbols must be
reachable from the root or from a listed subpath. Internal barrels such as source
folder indexes are private unless the export map and docs explicitly make them public.
