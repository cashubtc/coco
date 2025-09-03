# coco-cashu/core

Modular, storage-agnostic core for working with Cashu mints and wallets.

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
- [ ] NUT-10
- [ ] NUT-11
- [x] NUT-12
- [x] NUT-13
- [ ] NUT-14
- [ ] NUT-15
- [ ] NUT-16
- [x] NUT-17
- [ ] NUT-18
- [ ] NUT-19
- [ ] NUT-20
- [ ] NUT-21
- [ ] NUT-22
- [x] NUT-23
- [ ] NUT-24
- [ ] NUT-25

## Quick start

```ts
import { Manager, MemoryRepositories, ConsoleLogger } from 'coco-cashu-core';

// Provide a deterministic 64-byte seed for wallet key derivation
const seedGetter = async () => seed;

const repos = new MemoryRepositories();
const logger = new ConsoleLogger('example', { level: 'info' });
const manager = new Manager(repos, seedGetter, logger);

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

### Watchers (optional)

Start background watchers to automatically react to changes:

```ts
// Watch mint quote updates and auto-redeem previously pending ones on start (default true)
await manager.enableMintQuoteWatcher({ watchExistingPendingOnStart: true });

// Watch proof state updates (e.g., to move inflight proofs to spent)
await manager.enableProofStateWatcher();

// Later, you can stop them
await manager.disableMintQuoteWatcher();
await manager.disableProofStateWatcher();
```

## Architecture

- `Manager`: Facade wiring services together; exposes `mint`, `wallet`, `quotes`, and `subscription` APIs plus watcher helpers.
- `MintService`: Fetches `mintInfo`, keysets and persists via repositories.
- `WalletService`: Caches and constructs `CashuWallet` from stored keysets.
- `ProofService`: Manages proofs, selection, states, and counters.
- `MintQuoteService`: Creates and redeems mint quotes.
- `MeltQuoteService`: Creates and pays melt quotes (spend via Lightning).
- `CounterService`: Simple per-(mint,keyset) numeric counter with events.
- `EventBus<CoreEvents>`: Lightweight typed pub/sub used internally.

### Repositories

Interfaces in `packages/core/repositories/index.ts`:

- `MintRepository`
- `KeysetRepository`
- `CounterRepository`
- `ProofRepository`
- `MintQuoteRepository`
- `MeltQuoteRepository`

In-memory reference implementations are provided under `repositories/memory/` for testing.

## Public API surface

### Manager

- `mint: MintApi`
- `wallet: WalletApi`
- `quotes: QuotesApi`
- `subscription: SubscriptionApi`
- `on/once/off` for `CoreEvents`
- `enableMintQuoteWatcher(options?: { watchExistingPendingOnStart?: boolean }): Promise<void>`
- `disableMintQuoteWatcher(): Promise<void>`
- `enableProofStateWatcher(): Promise<void>`
- `disableProofStateWatcher(): Promise<void>`

### MintApi

- `addMint(mintUrl: string): Promise<{ mint: Mint; keysets: Keyset[] }>`
- `getMintInfo(mintUrl: string): Promise<MintInfo>`
- `isKnownMint(mintUrl: string): Promise<boolean>`
- `getAllMints(): Promise<Mint[]>`

### WalletApi

- `receive(token: Token | string): Promise<void>`
- `send(mintUrl: string, amount: number): Promise<Token>`
- `getBalances(): Promise<{ [mintUrl: string]: number }>`
- `restore(mintUrl: string): Promise<void>`

### QuotesApi

- `createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteResponse>`
- `redeemMintQuote(mintUrl: string, quoteId: string): Promise<void>`
- `createMeltQuote(mintUrl: string, invoice: string): Promise<MeltQuoteResponse>`
- `payMeltQuote(mintUrl: string, quoteId: string): Promise<void>`

### SubscriptionApi

- `awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<MintQuoteResponse>`
- `awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<MintQuoteResponse>`

### Subscriptions in Node vs browser

`Manager` will auto-detect a global `WebSocket` if available (e.g., browsers). In non-browser environments, provide a `webSocketFactory` to the `Manager` constructor or use the exposed `SubscriptionManager`/`WsConnectionManager` utilities.

## Core events

- `mint:added` → `{ mint, keysets }`
- `mint:updated` → `{ mint, keysets }`
- `counter:updated` → `Counter`
- `proofs:saved` → `{ mintUrl, keysetId, proofs }`
- `proofs:state-changed` → `{ mintUrl, secrets, state }`
- `proofs:deleted` → `{ mintUrl, secrets }`
- `proofs:wiped` → `{ mintUrl, keysetId }`
- `mint-quote:state-changed` → `{ mintUrl, quoteId, state }`
- `mint-quote:created` → `{ mintUrl, quoteId, quote }`
- `mint-quote:redeemed` → `{ mintUrl, quoteId, quote }`
- `melt-quote:created` → `{ mintUrl, quoteId, quote }`
- `melt-quote:paid` → `{ mintUrl, quoteId, quote }`

## Exports

From the package root:

- `Manager`
- Repository interfaces and memory implementations under `repositories/memory`
- Models under `models`
- Types: `CoreProof`, `ProofState`
- Logging: `ConsoleLogger`, `Logger`
- Helpers: `getEncodedToken`, `getDecodedToken`
- Subscription infra: `SubscriptionManager`, `WsConnectionManager`, `WebSocketLike`, `WebSocketFactory`, `SubscriptionCallback`, `SubscriptionKind`
