# KeyRing (P2PK)

The KeyRing feature enables Pay-to-Public-Key (P2PK) functionality in Coco Cashu, allowing you to lock tokens to specific public keys. This adds an extra layer of security by requiring cryptographic signatures to spend tokens.

## Overview

P2PK tokens are Cashu tokens that can only be spent by someone who possesses the corresponding private key. This prevents unauthorized spending even if someone intercepts the token.

### Use Cases

- **Secure Transfers**: Send tokens that only the intended recipient can spend
- **Multi-Device Wallets**: Share tokens between your own devices securely
- **Escrow**: Lock tokens that require specific key signatures
- **Time-Locked Payments**: Combine with other mechanisms for advanced use cases

## Key Management

### Generating New Keypairs

Coco can generate new keypairs derived from your BIP-39 seed using the derivation path `m/129373'/10'/0'/0'/{index}`:

```ts
// Generate a new keypair (returns only public key)
const { publicKeyHex } = await coco.keyring.generateKeyPair();
console.log('New public key:', publicKeyHex);

// Generate with access to the secret key
const keypair = await coco.keyring.generateKeyPair(true);
console.log('Public key:', keypair.publicKeyHex);
console.log('Secret key:', keypair.secretKey); // Uint8Array(32)
```

::: warning
The secret key is sensitive cryptographic material. When setting `dumpSecretKey: true`, ensure you handle the key securely and clear it from memory when no longer needed.
:::

### Importing Existing Keypairs

You can import external keypairs by providing a 32-byte secret key:

```ts
// Import a keypair from a 32-byte secret key
const secretKey = new Uint8Array(32); // Your 32-byte secret key
const keypair = await coco.keyring.addKeyPair(secretKey);
console.log('Imported public key:', keypair.publicKeyHex);
```

### Retrieving Keypairs

```ts
// Get a specific keypair by public key
const keypair = await coco.keyring.getKeyPair(publicKeyHex);
if (keypair) {
  console.log('Found keypair:', keypair.publicKeyHex);
}

// Get the most recently added keypair
const latest = await coco.keyring.getLatestKeyPair();

// Get all stored keypairs
const allKeypairs = await coco.keyring.getAllKeyPairs();
console.log(`You have ${allKeypairs.length} keypairs`);
```

### Removing Keypairs

```ts
// Remove a keypair by public key
await coco.keyring.removeKeyPair(publicKeyHex);
```

::: warning
Removing a keypair will prevent you from spending any P2PK tokens locked to that key. Ensure you have spent or transferred all associated tokens before removing a keypair.
:::

## Working with P2PK Tokens

### Receiving P2PK Tokens

When you receive a P2PK token, Coco automatically handles the signature verification if you have the corresponding keypair:

```ts
// The token is locked to one of your public keys
const token = 'cashuA...'; // P2PK token

try {
  const result = await coco.wallet.receive(token);
  console.log('Successfully received P2PK token:', result.amount);
} catch (error) {
  console.error('Failed to receive token:', error.message);
  // This might fail if you don't have the required keypair
}
```

## TypeScript Types

```ts
interface Keypair {
  publicKeyHex: string; // The public key as a hex string
  secretKey: Uint8Array; // The 32-byte secret key
  derivationIndex?: number; // BIP32 derivation index (if generated)
}

// KeyRing API methods
interface KeyRingApi {
  generateKeyPair(): Promise<{ publicKeyHex: string }>;
  generateKeyPair(dumpSecretKey: true): Promise<Keypair>;
  generateKeyPair(dumpSecretKey: false): Promise<{ publicKeyHex: string }>;

  addKeyPair(secretKey: Uint8Array): Promise<Keypair>;
  removeKeyPair(publicKey: string): Promise<void>;
  getKeyPair(publicKey: string): Promise<Keypair | null>;
  getLatestKeyPair(): Promise<Keypair | null>;
  getAllKeyPairs(): Promise<Keypair[]>;
}
```

## Storage

All keypairs are persisted across sessions using your chosen storage adapter (SQLite, IndexedDB, etc.). The secret keys are stored encrypted along with the public keys and derivation indices.

See [Storage Adapters](./storage-adapters.md) for more information on how data is persisted.

## Error Handling

```ts
try {
  await coco.wallet.receive(p2pkToken);
} catch (error) {
  if (error.message.includes('Key pair not found')) {
    console.error("You don't have the required keypair to spend this token");
    // You might need to import the keypair or ask the sender to unlock it
  }
}

try {
  await coco.keyring.addKeyPair(invalidKey);
} catch (error) {
  if (error.message.includes('must be exactly 32 bytes')) {
    console.error('Invalid secret key size');
  }
}
```

## Limitations

1. **No Key Recovery Without Seed**: Imported keys (non-derived) cannot be recovered from your BIP-39 seed
2. **Mint Support**: Not all mints support P2PK. Check mint capabilities before using
3. **No Key Rotation**: Once a token is locked to a key, it cannot be re-locked to a different key without spending it first

## Further Reading

- [Cashu NUT-11: P2PK Specification](https://github.com/cashubtc/nuts/blob/main/11.md)
- [BIP32: Hierarchical Deterministic Wallets](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)
- [Schnorr Signatures](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki)
