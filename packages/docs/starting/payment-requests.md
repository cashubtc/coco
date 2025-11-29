# Payment Requests

Payment requests (NUT-18) provide a standardized way to request payments in Cashu. A payment request encodes information about the requested payment, including the amount, allowed mints, and how the tokens should be delivered.

## Reading a Payment Request

To handle a payment request, first parse it using `readPaymentRequest`:

```ts
const paymentRequest = 'creqA...'; // encoded payment request

const prepared = await coco.wallet.readPaymentRequest(paymentRequest);

console.log('Transport:', prepared.transport.type);
console.log('Amount:', prepared.amount);
console.log('Allowed mints:', prepared.mints);
```

The returned `PreparedPaymentRequest` contains:

- **transport** - How to deliver the tokens (`inband` or `http`)
- **amount** - The requested amount (optional, but required for payment)
- **mints** - List of allowed mints (optional)

## Transport Types

Payment requests specify how tokens should be delivered:

### Inband Transport

With inband transport, your application handles the token delivery. This is useful for QR codes, NFC, messaging apps, or any custom delivery mechanism.

```ts
const prepared = await coco.wallet.readPaymentRequest(paymentRequest);

if (prepared.transport.type === 'inband') {
  await coco.wallet.handleInbandPaymentRequest(
    'https://mint.url',
    prepared,
    async (token) => {
      // Your delivery logic here
      // e.g., display as QR code, send via NFC, post to chat
      console.log('Token to deliver:', token);
    },
  );
}
```

### HTTP Transport

With HTTP transport, tokens are automatically POSTed to a URL specified in the payment request.

```ts
const prepared = await coco.wallet.readPaymentRequest(paymentRequest);

if (prepared.transport.type === 'http') {
  const response = await coco.wallet.handleHttpPaymentRequest(
    'https://mint.url',
    prepared,
  );

  if (response.ok) {
    console.log('Payment delivered successfully');
  } else {
    console.error('Payment delivery failed:', response.status);
  }
}
```

## Specifying the Amount

If the payment request doesn't include an amount, you must provide one:

```ts
// Amount from request
await coco.wallet.handleInbandPaymentRequest(mintUrl, prepared, handler);

// Override or provide amount
await coco.wallet.handleInbandPaymentRequest(mintUrl, prepared, handler, 100);
```

> **Note:** If the payment request specifies an amount, providing a different amount will throw an error. The requested amount is always exact.

## Choosing a Mint

Payment requests may restrict which mints are acceptable. Verify your chosen mint is allowed:

```ts
const prepared = await coco.wallet.readPaymentRequest(paymentRequest);

// Get your available balances
const balances = await coco.wallet.getBalances();

// Find a mint that has balance and is allowed
const mintUrl = Object.keys(balances).find((mint) => {
  const isAllowed = !prepared.mints || prepared.mints.includes(mint);
  const hasBalance = balances[mint] >= (prepared.amount ?? 0);
  return isAllowed && hasBalance;
});

if (!mintUrl) {
  throw new Error('No suitable mint found');
}

// Use this mint for the payment
await coco.wallet.handleHttpPaymentRequest(mintUrl, prepared);
```

## Error Handling

Payment request operations can throw errors in several cases:

```ts
try {
  const prepared = await coco.wallet.readPaymentRequest(paymentRequest);
  await coco.wallet.handleHttpPaymentRequest(mintUrl, prepared);
} catch (error) {
  // Possible errors:
  // - Malformed payment request
  // - Unsupported transport type
  // - Mint not in allowed list
  // - Amount mismatch
  // - Insufficient balance
  console.error('Payment failed:', error.message);
}
```

## Complete Example

```ts
async function payRequest(paymentRequest: string) {
  // 1. Parse the payment request
  const prepared = await coco.wallet.readPaymentRequest(paymentRequest);

  // 2. Find a suitable mint
  const balances = await coco.wallet.getBalances();
  const mintUrl = Object.keys(balances).find((mint) => {
    const isAllowed = !prepared.mints || prepared.mints.includes(mint);
    const hasBalance = balances[mint] >= (prepared.amount ?? 0);
    return isAllowed && hasBalance;
  });

  if (!mintUrl) {
    throw new Error('No suitable mint with sufficient balance');
  }

  // 3. Handle based on transport type
  if (prepared.transport.type === 'http') {
    const response = await coco.wallet.handleHttpPaymentRequest(
      mintUrl,
      prepared,
    );
    return { success: response.ok, response };
  }

  if (prepared.transport.type === 'inband') {
    let deliveredToken;
    await coco.wallet.handleInbandPaymentRequest(
      mintUrl,
      prepared,
      async (token) => {
        deliveredToken = token;
        // Add your delivery logic here
      },
    );
    return { success: true, token: deliveredToken };
  }

  throw new Error('Unknown transport type');
}
```

