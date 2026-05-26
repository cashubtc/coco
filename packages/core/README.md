# @cashu/coco-core

Modular, storage-agnostic core for working with Cashu mints and wallets.

> ⚠️ Release candidate: Coco is stabilizing for v1, but breaking changes may
> still land before the final 1.0 release. Pin versions in production.

- **Storage-agnostic**: Repositories are interfaces; bring your own persistence.
- **Typed Event Bus**: Subscribe to mint, proof, quote, and counter events with strong types.
- **High-level APIs**: `MintApi`, `WalletApi`, `AuthApi`, `PaymentRequestsApi`,
  `SubscriptionApi`, `HistoryApi`, `KeyRingApi`, and `manager.ops.*` for common
  flows.
- **Background watchers**: Optional services to track quote/payment and proof states.

## Install

```bash
npm install @cashu/coco-core
```

For a real application you will usually install a storage adapter alongside the
core package, for example `@cashu/coco-sqlite`, `@cashu/coco-indexeddb`, or
`@cashu/coco-expo-sqlite`. Bun applications can use `@cashu/coco-sqlite-bun`.

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
  mintUrl: 'https://nofees.testnut.cashu.space',
  quoteId: quote.quoteId,
  method: 'bolt11',
  methodData: {},
});

// Optionally, wait via subscription API instead of polling
await manager.subscription.awaitMintQuotePaid(
  'https://nofees.testnut.cashu.space',
  pendingMint.quoteId,
);

// pay pendingMint.request externally, then:
await manager.ops.mint.execute(pendingMint.id);

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

// Watch proof state updates (e.g., to move inflight proofs to spent)
await manager.enableProofStateWatcher();

// Later, you can stop them
await manager.disableMintOperationWatcher();
await manager.disableMintOperationProcessor();
await manager.disableProofStateWatcher();
```

### initializeCoco options

`initializeCoco` sets up repositories, plugins, watchers, and processors for you. You can configure it via `CocoConfig`:

- `repo`: `Repositories` implementation (required)
- `seedGetter`: async seed provider (required)
- `logger`: optional logger (defaults to `NullLogger`)
- `webSocketFactory`: optional WebSocket factory
- `plugins`: optional plugin list
- `watchers`: enable/disable watcher services (`mintOperationWatcher`, `proofStateWatcher`)
- `processors`: enable/disable processors (`mintOperationProcessor`) and tune intervals
- `subscriptions`: polling intervals for hybrid WebSocket + polling (`slowPollingIntervalMs`, `fastPollingIntervalMs`)

If you prefer manual wiring, construct `Manager` directly and call `initPlugins()` before enabling watchers/processors.

## Architecture

- `Manager`: Facade wiring services together; exposes `mint`, `wallet`, `ops`,
  `quotes`, `paymentRequests`, and `subscription` APIs plus watcher helpers.
- `MintService`: Fetches `mintInfo`, keysets and persists via repositories.
- `WalletService`: Caches and constructs `Wallet` from stored keysets.
- `ProofService`: Manages proofs, selection, states, and counters.
- Legacy mint quote orchestration has been replaced by `MintOperationService`,
  `manager.ops.mint`, and canonical quote resurfacing through `manager.quotes.mint`.
- Legacy melt quote orchestration has been replaced by `MeltOperationService`,
  `manager.ops.melt`, and canonical quote resurfacing through `manager.quotes.melt`.
- `CounterService`: Simple per-(mint,keyset) numeric counter with events.
- `EventBus<CoreEvents>`: Lightweight typed pub/sub used internally (includes `subscriptions:paused` and `subscriptions:resumed`).

### Repositories

Interfaces in `packages/core/repositories/index.ts`:

- `MintRepository`
- `KeysetRepository`
- `CounterRepository`
- `ProofRepository`
- `MintQuoteRepository`
- `HistoryRepository`
- `KeyRingRepository`
- `AuthSessionRepository`
- `SendOperationRepository`
- `MeltOperationRepository`
- `MintOperationRepository`
- `ReceiveOperationRepository`

In-memory reference implementations are provided under `repositories/memory/` for testing.

## Public API surface

### Manager

- `mint`, `wallet`, `auth`, `quotes`, `paymentRequests`, `ops`,
  `subscription`, `history`, and `keyring`
- `ext: PluginExtensions`
- `on/once/off` for `CoreEvents`
- `enableMintOperationWatcher()`, `disableMintOperationWatcher()`
- `enableMintOperationProcessor()`, `disableMintOperationProcessor()`,
  `waitForMintOperationProcessor()`
- `enableProofStateWatcher()`, `disableProofStateWatcher()`
- `pauseSubscriptions()`, `resumeSubscriptions()`
- `use(plugin: Plugin): void`
- `initPlugins(): Promise<void>`
- `dispose(): Promise<void>`

### OpsApi

- `send`: `prepare`, `execute`, `get`, `listPrepared`, `listInFlight`,
  `refresh`, `cancel`, `reclaim`, plus `recovery` and `diagnostics`
- `receive`: `prepare`, `execute`, `get`, `listPrepared`, `listInFlight`,
  `refresh`, `cancel`, plus `recovery` and `diagnostics`
- `mint`: `prepare`, `importQuote`, `execute`, `get`, `getByQuote`,
  `listPending`, `listInFlight`, `checkPayment`, `refresh`, `finalize`, plus
  `recovery` and `diagnostics`
- `melt`: `prepare`, `execute`, `get`, `getByQuote`, `listPrepared`,
  `listInFlight`, `refresh`, `cancel`, `reclaim`, `finalize`, plus `recovery`
  and `diagnostics`

### MintApi

- `addMint(mintUrl: string, options?: { trusted?: boolean }): Promise<{ mint: Mint; keysets: Keyset[] }>`
- `getMintInfo(mintUrl: string): Promise<MintInfo>`
- `isTrustedMint(mintUrl: string): Promise<boolean>`
- `getAllMints(): Promise<Mint[]>`
- `getAllTrustedMints(): Promise<Mint[]>`
- `trustMint(mintUrl: string): Promise<void>`
- `untrustMint(mintUrl: string): Promise<void>`

### WalletApi

- `receive(token: Token | string): Promise<void>`
- `balances.byMint(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByMint>`
- `balances.byMintAndUnit(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByMintAndUnit>`
- `balances.byUnit(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByUnit>`
- `balances.total(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalanceSnapshot>`
- `balances.totalByUnit(scope?: { mintUrls?: string[]; units?: string[]; trustedOnly?: boolean }): Promise<BalancesByUnit>`
- `restore(mintUrl: string, options?: { units?: string[] }): Promise<void>`
- `sweep(mintUrl: string, bip39seed: Uint8Array, options?: { units?: string[] }): Promise<void>`
- `decodeToken(tokenString: string, mintUrl?: string): Promise<Token>`
- `encodeToken(token: Token, opts?: { removeDleq?: boolean }): string`
- `encodePaymentRequest(paymentRequest: PaymentRequest, version?: 'creqA' | 'creqB'): string`

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
- `prepare(request: ResolvedPaymentRequest, options: { mintUrl: string; amount?: AmountLike }): Promise<PreparedPaymentRequest>`
- `execute(transaction: PreparedPaymentRequest): Promise<PaymentRequestExecutionResult>`
- `incoming.create(input: CreateIncomingPaymentRequestInput): Promise<PaymentRequestReceiveOperation>`

### SubscriptionApi

- `awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<unknown>`
- `awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<unknown>`

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

`Manager` will auto-detect a global `WebSocket` if available (e.g., browsers). In non-browser environments, provide a `webSocketFactory` to the `Manager` constructor or use the exposed `SubscriptionManager`/`WsConnectionManager` utilities.

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
- `mint-op:pending` → `{ mintUrl, operationId, operation }`
- `mint-op:requeue` → `{ mintUrl, operationId, operation }`
- `mint-op:executing` → `{ mintUrl, operationId, operation }`
- `mint-op:finalized` → `{ mintUrl, operationId, operation }`
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
- **Cleanup**: Hooks must return a cleanup function (sync or async), similar to React’s `useEffect`.

### Types

```ts
import type { Plugin, ServiceKey } from '@cashu/coco-core';

// Service keys are derived from the exported ServiceMap type.
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

- Errors thrown in `onInit`, `onReady`, and `onDispose` are caught. Hook errors are logged with the plugin name; a failure during plugin boot is also logged by the injected `Logger`.

## Exports

From the package root:

- `Manager`, `initializeCoco`, `CocoConfig`
- Repository interfaces and memory implementations
- Public APIs including `MintApi`, `WalletApi`, `AuthApi`, `PaymentRequestsApi`,
  `SubscriptionApi`, and the operation-oriented APIs
- Models, services, operations, and plugin types
- Types: `CoreProof`, `ProofState`, `BalanceQuery`, `BalanceSnapshot`,
  `BalancesByMint`, `BalanceBreakdown`, `BalancesBreakdownByMint`
- Logging: `ConsoleLogger`, `Logger`
- Helpers: `getEncodedToken`, `getDecodedToken`, `normalizeMintUrl`
- Infrastructure helpers: `SubscriptionManager`, `WsConnectionManager`,
  `WebSocketLike`, `WebSocketFactory`
