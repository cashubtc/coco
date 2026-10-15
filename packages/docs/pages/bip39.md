# Bip39

Coco is a deterministic wallet by default. That means it will only work when given a BIP-39 compatible seed. The seed will be used to derive keys and secrets internally

## Seed Getter

The BIP-39 seed is never persisted by coco, instead it needs to be supplied via a `seedGetter` function that is passed at instantiation:

```ts
import { initializeCoco } from '@cashu/coco-core';

async function seedGetter(): Promise<Uint8Array> {
  // Add your implementation here
}

const coco = await initializeCoco({
  repo, // See storage adapters to learn more
  seedGetter,
});
```

Coco will call this function whenever it needs to access the seed

## Restore

Once instantiated you can use the deterministic secret restore `coco.wallet.restore()` to restore secrets and counters based on the seed on a certain mint. Coco will get all available keysets from the mint and perform a restore for each one, including custom-unit keysets.

```ts
await coco.wallet.restore('https://mint.url');
// Newly discovered, unspent deterministic proofs are now available.
// Note: Restore will automatically cache the mint info if not already present
```

Restore applies each keyset's proof imports and counter advancement in one local
transaction. Repeating it is safe: identical existing proofs keep their state and
operation ownership, and counters never move backwards. Conflicting stored proof
material rejects that keyset's application without partial writes. Other keysets
may already have committed when a keyset fails.

Only proofs positively reported as `UNSPENT` are newly imported. `PENDING` proofs
are skipped, and `SPENT` proofs are not imported. Counters still advance past all
observed signatures, including pending and spent ones. To recover a skipped proof
that later becomes unspent, call Restore again; scanning starts at zero, and there
is no automatic follow-up for skipped proofs. Restore does not release existing
operation reservations or revive locally spent proofs.

Proof and counter events are emitted after the keyset transaction commits. Listener
failures are logged and do not turn a committed Restore into a persistence failure.

To restore only selected units, pass a unit filter:

```ts
await coco.wallet.restore('https://mint.url', { units: ['usd'] });
```

The same unit filter is available for sweeping an older seed into the current
wallet. Sweep also uses only positively unspent inputs and skips pending proofs:

```ts
await coco.wallet.sweep('https://mint.url', oldSeed);
await coco.wallet.sweep('https://mint.url', oldSeed, { units: ['usd'] });
```

> **Note:** The `restore()` method will add and trust the mint automatically. If you want to display mint info to the user before proceeding use `addMint()` as described in [Adding a Mint](../starting/adding-mints.md)
