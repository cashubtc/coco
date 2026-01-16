# coco-cashu/core

Modular, storage-agnostic core for working with Cashu mints and wallets.

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

- **Storage-agnostic**: Repositories are interfaces; bring your own persistence.
- **Typed Event Bus**: Subscribe to mint, proof, quote, and counter events with strong types.
- **High-level APIs**: `MintApi`, `WalletApi`, `QuotesApi`, and `SubscriptionApi` for common flows.
- **Background watchers**: Optional services to track quote/payment and proof states.

## Install

```bash
bun install
```

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
- [ ] NUT-21
- [ ] NUT-22
- [x] NUT-23
- [ ] NUT-24
- [ ] NUT-25

## Quick start

```ts
import { initializeCoco, MemoryRepositories, ConsoleLogger } from 'coco-cashu-core';

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

// Create a mint quote, pay externally, then redeem
const mintQuote = await manager.quotes.createMintQuote('https://nofees.testnut.cashu.space', 100);

// Optionally, wait via subscription API instead of polling
await manager.subscription.awaitMintQuotePaid(
  'https://nofees.testnut.cashu.space',
  mintQuote.quote,
);

// pay mintQuote.request externally, then:
await manager.quotes.redeemMintQuote('https://nofees.testnut.cashu.space', mintQuote.quote);

// Check balances
const balances = await manager.wallet.getBalances();
console.log('balances', balances);
```

### Watchers & processors (optional)

Start background watchers or processors to automatically react to changes:

```ts
// Watch mint quote updates and auto-redeem previously pending ones on start (default true)
await manager.enableMintQuoteWatcher({ watchExistingPendingOnStart: true });

// Process queued mint quotes (auto-enabled by initializeCoco)
await manager.enableMintQuoteProcessor({ processIntervalMs: 3000 });

// Watch proof state updates (e.g., to move inflight proofs to spent)
await manager.enableProofStateWatcher();

// Later, you can stop them
await manager.disableMintQuoteWatcher();
await manager.disableMintQuoteProcessor();
await manager.disableProofStateWatcher();
```

### initializeCoco options

`initializeCoco` sets up repositories, plugins, watchers, and processors for you. You can configure it via `CocoConfig`:

- `repo`: `Repositories` implementation (required)
- `seedGetter`: async seed provider (required)
- `logger`: optional logger (defaults to `NullLogger`)
- `webSocketFactory`: optional WebSocket factory
- `plugins`: optional plugin list
- `watchers`: enable/disable watcher services (`mintQuoteWatcher`, `proofStateWatcher`)
- `processors`: enable/disable processors (`mintQuoteProcessor`) and tune intervals
- `subscriptions`: polling intervals for hybrid WebSocket + polling (`slowPollingIntervalMs`, `fastPollingIntervalMs`)

If you prefer manual wiring, construct `Manager` directly and call `initPlugins()` before enabling watchers/processors.

## Architecture

- `Manager`: Facade wiring services together; exposes `mint`, `wallet`, `quotes`, and `subscription` APIs plus watcher helpers.
- `MintService`: Fetches `mintInfo`, keysets and persists via repositories.
- `WalletService`: Caches and constructs `Wallet` from stored keysets.
- `ProofService`: Manages proofs, selection, states, and counters.
- `MintQuoteService`: Creates and redeems mint quotes.
- `MeltQuoteService`: Creates and pays melt quotes (spend via Lightning).
- `CounterService`: Simple per-(mint,keyset) numeric counter with events.
- `EventBus<CoreEvents>`: Lightweight typed pub/sub used internally (includes `subscriptions:paused` and `subscriptions:resumed`).

### Repositories

Interfaces in `packages/core/repositories/index.ts`:

- `MintRepository`
- `KeysetRepository`
- `CounterRepository`
- `ProofRepository`
- `MintQuoteRepository`
- `MeltQuoteRepository`
- `HistoryRepository`
- `KeyRingRepository`
- `SendOperationRepository`
- `MeltOperationRepository`

In-memory reference implementations are provided under `repositories/memory/` for testing.

## Public API surface

### Manager

- `mint: MintApi`
- `wallet: WalletApi`
- `quotes: QuotesApi`
- `subscription: SubscriptionApi`
- `history: HistoryApi`
- `keyring: KeyRingApi`
- `send: SendApi`
- `ext: PluginExtensions`
- `on/once/off` for `CoreEvents`
- `enableMintQuoteWatcher(options?: { watchExistingPendingOnStart?: boolean }): Promise<void>`
- `disableMintQuoteWatcher(): Promise<void>`
- `enableMintQuoteProcessor(options?: { processIntervalMs?: number; maxRetries?: number; baseRetryDelayMs?: number; initialEnqueueDelayMs?: number }): Promise<boolean>`
- `disableMintQuoteProcessor(): Promise<void>`
- `waitForMintQuoteProcessor(): Promise<void>`
- `enableProofStateWatcher(): Promise<void>`
- `disableProofStateWatcher(): Promise<void>`
- `pauseSubscriptions(): Promise<void>`
- `resumeSubscriptions(): Promise<void>`
- `recoverPendingSendOperations(): Promise<void>`
- `use(plugin: Plugin): void`
- `initPlugins(): Promise<void>`
- `dispose(): Promise<void>`

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
- `getBalances(): Promise<{ [mintUrl: string]: number }>`
- `restore(mintUrl: string): Promise<void>`
- `sweep(mintUrl: string, bip39seed: Uint8Array): Promise<void>`
- `processPaymentRequest(paymentRequest: string): Promise<ParsedPaymentRequest>`
- `preparePaymentRequestTransaction(mintUrl: string, request: ParsedPaymentRequest, amount?: number): Promise<PaymentRequestTransaction>`
- `handleInbandPaymentRequest(transaction: PaymentRequestTransaction, inbandHandler: (token: Token) => Promise<void>): Promise<void>`
- `handleHttpPaymentRequest(transaction: PaymentRequestTransaction): Promise<Response>`

### QuotesApi

- `createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteResponse>`
- `redeemMintQuote(mintUrl: string, quoteId: string): Promise<void>`
- `prepareMeltBolt11(mintUrl: string, invoice: string): Promise<PreparedMeltOperation>`
- `executeMelt(operationId: string): Promise<PendingMeltOperation | FinalizedMeltOperation>`
- `executeMeltByQuote(mintUrl: string, quoteId: string): Promise<PendingMeltOperation | FinalizedMeltOperation | null>`
- `checkPendingMelt(operationId: string): Promise<PendingCheckResult>`
- `checkPendingMeltByQuote(mintUrl: string, quoteId: string): Promise<PendingCheckResult | null>`
- `addMintQuote(mintUrl: string, quotes: MintQuoteResponse[]): Promise<{ added: string[]; skipped: string[] }>`
- `requeuePaidMintQuotes(mintUrl?: string): Promise<{ requeued: string[] }>`

### SubscriptionApi

- `awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<unknown>`
- `awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<unknown>`

### HistoryApi

- `getPaginatedHistory(offset?: number, limit?: number): Promise<HistoryEntry[]>`
- `getHistoryEntryById(id: string): Promise<HistoryEntry | null>`

### KeyRingApi

- `generateKeyPair(dumpSecretKey?: boolean): Promise<{ publicKeyHex: string } | Keypair>`
- `addKeyPair(secretKey: Uint8Array): Promise<Keypair>`
- `removeKeyPair(publicKey: string): Promise<void>`
- `getKeyPair(publicKey: string): Promise<Keypair | null>`
- `getLatestKeyPair(): Promise<Keypair | null>`
- `getAllKeyPairs(): Promise<Keypair[]>`

### SendApi

- `prepareSend(mintUrl: string, amount: number): Promise<PreparedSendOperation>`
- `executePreparedSend(operationId: string): Promise<{ operation: PendingSendOperation; token: Token }>`
- `getOperation(operationId: string): Promise<SendOperation | null>`
- `getPendingOperations(): Promise<SendOperation[]>`
- `finalize(operationId: string): Promise<void>`
- `rollback(operationId: string): Promise<void>`
- `recoverPendingOperations(): Promise<void>`
- `checkPendingOperation(operationId: string): Promise<void>`
- `isOperationLocked(operationId: string): boolean`
- `isRecoveryInProgress(): boolean`

### Subscriptions in Node vs browser

`Manager` will auto-detect a global `WebSocket` if available (e.g., browsers). In non-browser environments, provide a `webSocketFactory` to the `Manager` constructor or use the exposed `SubscriptionManager`/`WsConnectionManager` utilities.

## Core events

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
- `mint-quote:state-changed` → `{ mintUrl, quoteId, state }`
- `mint-quote:created` → `{ mintUrl, quoteId, quote }`
- `mint-quote:added` → `{ mintUrl, quoteId, quote }`
- `mint-quote:requeue` → `{ mintUrl, quoteId }`
- `mint-quote:redeemed` → `{ mintUrl, quoteId, quote }`
- `melt-quote:created` → `{ mintUrl, quoteId, quote }`
- `melt-quote:state-changed` → `{ mintUrl, quoteId, state }`
- `melt-quote:paid` → `{ mintUrl, quoteId, quote }`
- `send:prepared` → `{ mintUrl, operationId, operation }`
- `send:pending` → `{ mintUrl, operationId, operation, token }`
- `send:finalized` → `{ mintUrl, operationId, operation }`
- `send:rolled-back` → `{ mintUrl, operationId, operation }`
- `receive:created` → `{ mintUrl, token }`
- `history:updated` → `{ mintUrl, entry }`
- `melt-op:prepared` → `{ mintUrl, operationId, operation }`
- `melt-op:pending` → `{ mintUrl, operationId, operation }`
- `melt-op:finalized` → `{ mintUrl, operationId, operation }`
- `melt-op:rolled-back` → `{ mintUrl, operationId, operation }`

## Plugins

### Overview

- **Purpose**: Extend the core by hooking into lifecycle events with access only to the services you declare.
- **Lifecycle hooks**: `onInit` (after services are created), `onReady` (after APIs are built), `onDispose` (on shutdown).
- **Cleanup**: Hooks must return a cleanup function (sync or async), similar to React’s `useEffect`.

### Types

```ts
import type { Plugin, ServiceKey } from 'coco-cashu-core';

// Service keys you can request:
// 'mintService' | 'walletService' | 'proofService' | 'seedService' | 'walletRestoreService'
// 'counterService' | 'mintQuoteService' | 'meltQuoteService' | 'historyService'
// 'subscriptions' | 'eventBus' | 'logger'

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
- Repository interfaces and memory implementations under `repositories/memory`
- Models under `models`
- Types: `CoreProof`, `ProofState`
- Logging: `ConsoleLogger`, `Logger`
- Helpers: `getEncodedToken`, `getDecodedToken`, `normalizeMintUrl`
- Subscription infra: `SubscriptionManager`, `WsConnectionManager`, `WebSocketLike`, `WebSocketFactory`, `SubscriptionCallback`, `SubscriptionKind`
- Plugins: `Plugin`, `PluginContext`, `ServiceKey`, `PluginHost`
