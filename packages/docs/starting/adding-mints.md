# Adding a mint

## Trust Model

Coco uses a trust-based security model for mints. Wallet operations (receiving, sending, minting, melting) require explicitly trusted mints. This allows you to cache and inspect mint information before deciding to trust it.

## Adding and Trusting Mints

### Preview First (Recommended)

You can fetch and cache mint information without trusting it:

```ts
const coco = await initializeCoco({ repo, seedGetter });

const mintUrl = 'https://minturl.com';

// Fetch and cache mint info (not yet trusted)
await coco.mint.addMint(mintUrl);

// Inspect the mint information
const mintInfo = await coco.mint.getMintInfo(mintUrl);
console.log('Mint name:', mintInfo.name);
console.log('Mint description:', mintInfo.description);

// Decide to trust it
await coco.mint.trustMint(mintUrl);

// Now you can perform wallet operations
const quote = await coco.quotes.createMintQuote(mintUrl, 21);
```

### Trust Immediately

If you already trust a mint, you can add it as trusted in one step:

```ts
const mintUrl = 'https://trustworthy-mint.com';

// Add and trust in one call
await coco.mint.addMint(mintUrl, { trusted: true });

// Ready for wallet operations
const quote = await coco.quotes.createMintQuote(mintUrl, 21);
```

## Trust Management

```ts
// Check if a mint is trusted
const isTrusted = await coco.mint.isTrustedMint(mintUrl);

// Untrust a mint (cached info remains)
await coco.mint.untrustMint(mintUrl);

// Get all trusted mints
const trustedMints = await coco.mint.getAllTrustedMints();
```

## Error Handling

Attempting wallet operations with untrusted mints will throw an error:

```ts
try {
  await coco.wallet.receive(token); // from untrusted mint
} catch (error) {
  console.error(error.message); // "Mint https://... is not trusted"
}
```
