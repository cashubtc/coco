# Bip39

Coco is a deterministic wallet by default. That means it will only work when given a BIP-39 compatible seed. The seed will be used to derive keys and secrets internally

## Seed Getter

The BIP-39 seed is never persisted by coco, instead it needs to be supplied via a `seedGetter` function that is passed at instantiation:

```ts
async function seedGetter(): Promise<Uint8Array> {
  // Add your implementation here
}

const coco = new Manager(
  repo, // See storage adapters to learn more
  seedGetter,
  // other params
);
```

Coco will call this function whenever it needs to access the seed

## Restore

Once instantiated you can use the deterministic secret restore `Manager.wallet.restore()` to restore secrets and counters based on the seed on a certain mint. Coco will get all available keysets from the mint and perform a restore for each one.

```ts
await coco.wallet.restore('https://mint.url');
// After this the balance for this mint will be restored.
// Note: Restore will automatically cache the mint info if not already present
```

> **Note:** The `restore()` method will add and trust the mint automatically. If you want to display mint info to the user before proceeding use `addMintByUrl` as described in [Adding a Mint](./adding-mints.md)
