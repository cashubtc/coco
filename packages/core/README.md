# coco-cashu/core

Modular, storage-agnostic core for working with Cashu mints and wallets.

- **Storage-agnostic**: Repositories are interfaces; bring your own persistence.
- **Typed Event Bus**: Subscribe to `mint:added`, `mint:updated`, `counter:updated`.
- **Wallet builder**: Builds `CashuWallet` with fetched mint info and keysets.

## Install

```bash
bun install
```

## Quick start

```ts
import { Manager } from "coco-cashu/core/Manager";
import { MemoryMintRepository } from "coco-cashu/core/repositories/memory/MemoryMintRepository";
import { MemoryKeysetRepository } from "coco-cashu/core/repositories/memory/MemoryKeysetRepository";
import { MemoryCounterRepository } from "coco-cashu/core/repositories/memory/MemoryCounterRepository";

const manager = new Manager({
  mintRepository: new MemoryMintRepository(),
  keysetRepository: new MemoryKeysetRepository(),
  counterRepository: new MemoryCounterRepository(),
});

// Subscribe to events (typed)
const unsubscribe = manager.on("counter:updated", (c) => {
  console.log("counter updated", c);
});

// Register a mint and get a wallet
await manager.addMint("https://nofees.testnut.cashu.space");
const { wallet, keysetId } = await manager.getWallet(
  "https://nofees.testnut.cashu.space"
);
const counter = await manager.getCounter(
  "https://nofees.testnut.cashu.space",
  keysetId
);
```

## Architecture

- `Manager`: Facade wiring services together. Exposes subscription helpers.
- `MintService`: Fetches `mintInfo`, keysets and persists via repositories.
- `WalletService`: Caches and constructs `CashuWallet` from stored keysets.
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

- `addMint(mintUrl: string): Promise<{ mint; keysets; }>`
- `getWallet(mintUrl: string): Promise<{ wallet; keysetId; }>`
- `getCounter(mintUrl: string, keysetId: string): Promise<number>`
- `incrementCounter(mintUrl: string, keysetId: string, n: number): Promise<number>`
- `on/once/off` for `CoreEvents`

### Core events

- `mint:added` → `{ mint, keysets }`
- `mint:updated` → `{ mint, keysets }`
- `counter:updated` → `Counter`

## Developing

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.18. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
