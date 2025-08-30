# coco-cashu/core

Modular, storage-agnostic core for working with Cashu mints and wallets.

- **Storage-agnostic**: Repositories are interfaces; bring your own persistence.
- **Typed Event Bus**: Subscribe to `mint:added`, `mint:updated`, `counter:updated`, proof lifecycle and mint-quote events.
- **Wallet APIs**: High-level `WalletApi`, `MintApi`, and `QuotesApi` for common flows.

## Install

```bash
bun install
```

## Quick start

```ts
import { Manager } from 'coco-cashu-core';
import { MemoryRepositories } from 'coco-cashu-core';
import { ConsoleLogger } from 'coco-cashu-core';

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
const quote = await manager.quotes.createMintQuote('https://nofees.testnut.cashu.space', 100);
// pay quote.request externally, then:
await manager.quotes.redeemMintQuote('https://nofees.testnut.cashu.space', quote.quote);

// Check balances
const balances = await manager.wallet.getBalances();
console.log('balances', balances);
```

## Architecture

- `Manager`: Facade wiring services together; exposes `mint`, `wallet`, and `quotes` APIs and subscription helpers.
- `MintService`: Fetches `mintInfo`, keysets and persists via repositories.
- `WalletService`: Caches and constructs `CashuWallet` from stored keysets.
- `ProofService`: Manages proofs, selection, states, and counters.
- `MintQuoteService`: Creates and redeems mint quotes.
- `CounterService`: Simple per-(mint,keyset) numeric counter with events.
- `EventBus<CoreEvents>`: Lightweight typed pub/sub used internally.

### Repositories

Interfaces in `packages/core/repositories/index.ts`:

- `MintRepository`
- `KeysetRepository`
- `CounterRepository`

In-memory reference implementations are provided under `repositories/memory/` for testing.

## API surface

### Manager

- `mint.addMint(mintUrl: string)`
- `mint.getMintInfo(mintUrl: string)`
- `wallet.receive(token)` / `wallet.send(mintUrl, amount)` / `wallet.getBalances()` / `wallet.restore(mintUrl)`
- `quotes.createMintQuote(mintUrl, amount)` / `quotes.redeemMintQuote(mintUrl, quoteId)`
- `on/once/off` for `CoreEvents`

### Core events

- `mint:added` → `{ mint, keysets }`
- `mint:updated` → `{ mint, keysets }`
- `counter:updated` → `Counter`
- `proofs:saved` → `{ mintUrl, keysetId, proofs }`
- `proofs:state-changed` → `{ mintUrl, secrets, state }`
- `proofs:deleted` → `{ mintUrl, secrets }`
- `proofs:wiped` → `{ mintUrl, keysetId }`
- `mint-quote:created` → `{ mintUrl, quoteId, quote }`
- `mint-quote:state-changed` → `{ mintUrl, quoteId, state }`
