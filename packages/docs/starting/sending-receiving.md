# Sending and Receiving Tokens

Cashu tokens can be sent between users as encoded strings. Coco provides simple methods for both sending and receiving tokens.

## Receiving Tokens

To receive a Cashu token, use the `receive` method. The token can be passed as either an encoded string or a parsed `Token` object:

```ts
// Receive an encoded token string
await coco.wallet.receive('cashuBpGF0gaJhaUgA...');

// Or receive a parsed token object
const token = { mint: 'https://mint.url', proofs: [...] };
await coco.wallet.receive(token);
```

> **Note:** The mint must be trusted before receiving tokens. See [Adding a Mint](./adding-mints.md).

### Events

You can listen for receive events:

```ts
coco.on('receive:created', ({ mintUrl, token }) => {
  console.log(`Received ${token.proofs.reduce((a, p) => a + p.amount, 0)} sats from ${mintUrl}`);
});
```

## Sending Tokens

### Send with Fee Preview

When sending tokens, a swap may be required if you don't have exact change. Swaps incur fees. To show the user fees before committing:

```ts
// 1. Prepare the send (reserves proofs, calculates fee)
const prepared = await coco.send.prepareSend('https://mint.url', 100);

console.log('Fee:', prepared.fee);
console.log('Needs swap:', prepared.needsSwap);
console.log('Input amount:', prepared.inputAmount);

// 2. Let user confirm, then execute
if (userConfirmed) {
  const { token } = await coco.send.executePreparedSend(prepared.id);
  console.log('Token to share:', token);
} else {
  // Cancel the operation
  await coco.send.rollback(prepared.id);
}
```

### Understanding Fees

- **Exact match** (`needsSwap: false`): No fee is charged when your proofs exactly match the send amount
- **Swap required** (`needsSwap: true`): A fee is charged when proofs need to be split

The `fee` field shows the exact fee in sats that will be deducted.

## Token Lifecycle

After sending, the token enters a "pending" state until the recipient claims it:

```ts
// Get pending send operations
const pending = await coco.send.getPendingOperations();

for (const op of pending) {
  console.log(`Operation ${op.id}: ${op.amount} sats, state: ${op.state}`);
}
```

### Reclaiming Unclaimed Tokens

If the recipient never claims the token, you can reclaim it:

```ts
// Rollback reclaims the proofs (minus any fees for the reclaim swap)
await coco.send.rollback(operationId);
```

### Finalizing Claimed Tokens

When proofs are confirmed spent (recipient claimed), the operation can be finalized:

```ts
await coco.send.finalize(operationId);
```

> **Note:** With [ProofStateWatcher](../pages/watchers-processors.md) enabled, finalization happens automatically when the mint reports proofs as spent.

## Paying Lightning Invoices (Melt)

Use melt operations to pay BOLT11 invoices via the Quotes API:

- `prepareMeltBolt11(mintUrl: string, invoice: string): Promise<PreparedMeltOperation>`
- `executeMelt(operationId: string): Promise<PendingMeltOperation | FinalizedMeltOperation>`
- `executeMeltByQuote(mintUrl: string, quoteId: string): Promise<PendingMeltOperation | FinalizedMeltOperation | null>`
- `checkPendingMelt(operationId: string): Promise<PendingCheckResult>`
- `checkPendingMeltByQuote(mintUrl: string, quoteId: string): Promise<PendingCheckResult | null>`

## Events

Listen for send lifecycle events:

```ts
// Proofs reserved, ready to execute
coco.on('send:prepared', ({ operationId, operation }) => {
  console.log(`Send prepared: ${operation.amount} sats`);
});

// Token created, waiting for recipient
coco.on('send:pending', ({ operationId, token }) => {
  console.log('Token ready to share');
});

// Recipient claimed the token
coco.on('send:finalized', ({ operationId }) => {
  console.log('Send completed');
});

// Operation cancelled, proofs reclaimed
coco.on('send:rolled-back', ({ operationId }) => {
  console.log('Send cancelled');
});
```

## Complete Example

```ts
async function sendWithConfirmation(mintUrl: string, amount: number) {
  // Prepare and show fee
  const prepared = await coco.send.prepareSend(mintUrl, amount);

  if (prepared.needsSwap) {
    console.log(`This send requires a swap. Fee: ${prepared.fee} sats`);
    const proceed = await askUserConfirmation();

    if (!proceed) {
      await coco.send.rollback(prepared.id);
      return null;
    }
  }

  // Execute the send
  const { token } = await coco.send.executePreparedSend(prepared.id);

  return token;
}

// Usage
const token = await sendWithConfirmation('https://mint.url', 100);
if (token) {
  // Display token as QR code, copy to clipboard, etc.
  displayToken(token);
}
```

## Error Handling

```ts
import { UnknownMintError, ProofValidationError } from 'coco-cashu-core';

try {
  const prepared = await coco.send.prepareSend(mintUrl, amount);
  const { token } = await coco.send.executePreparedSend(prepared.id);
} catch (error) {
  if (error instanceof UnknownMintError) {
    console.error('Mint is not trusted');
  } else if (error instanceof ProofValidationError) {
    console.error('Insufficient balance or invalid amount');
  } else {
    console.error('Send failed:', error.message);
  }
}
```
