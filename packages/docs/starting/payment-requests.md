# Payment Requests

Payment requests (NUT-18) provide a standardized way to request payments in Cashu. A payment request encodes information about the requested payment, including the amount, allowed mints, and how the tokens should be delivered.

## Reading a Payment Request

To handle a payment request, first parse it using `processPaymentRequest`:

```ts
const paymentRequest = 'creqA...'; // encoded payment request

const prepared = await coco.wallet.processPaymentRequest(paymentRequest);

console.log('Transport:', prepared.transport.type);
console.log('Amount:', prepared.amount);
console.log('Allowed mints:', prepared.requiredMints);
console.log('Matching mints:', prepared.matchingMints);
```

The returned `ParsedPaymentRequest` contains:

- **transport** - How to deliver the tokens (`inband` or `http`)
- **amount** - The requested amount (optional, but required for payment)
- **requiredMints** - List of allowed mints from the request
- **matchingMints** - Trusted mints with sufficient balance

## Transport Types

Payment requests specify how tokens should be delivered:

### Inband Transport

With inband transport, your application handles the token delivery. This is useful for QR codes, NFC, messaging apps, or any custom delivery mechanism.

```ts
const prepared = await coco.wallet.processPaymentRequest(paymentRequest);

if (prepared.transport.type === 'inband') {
  const transaction = await coco.wallet.preparePaymentRequestTransaction(
    'https://mint.url',
    prepared,
  );
  await coco.wallet.handleInbandPaymentRequest(
    transaction,
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
const prepared = await coco.wallet.processPaymentRequest(paymentRequest);

if (prepared.transport.type === 'http') {
  const transaction = await coco.wallet.preparePaymentRequestTransaction(
    'https://mint.url',
    prepared,
  );
  const response = await coco.wallet.handleHttpPaymentRequest(transaction);

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
const transaction = await coco.wallet.preparePaymentRequestTransaction(mintUrl, prepared);
await coco.wallet.handleInbandPaymentRequest(transaction, handler);

// Override or provide amount
const customTx = await coco.wallet.preparePaymentRequestTransaction(mintUrl, prepared, 100);
await coco.wallet.handleInbandPaymentRequest(customTx, handler);
```

> **Note:** If the payment request specifies an amount, providing a different amount will throw an error. The requested amount is always exact.

## Choosing a Mint

Payment requests may restrict which mints are acceptable. Verify your chosen mint is allowed:

```ts
const prepared = await coco.wallet.processPaymentRequest(paymentRequest);

// Pick any mint that matches the request
const mintUrl = prepared.matchingMints[0];

if (!mintUrl) {
  throw new Error('No suitable mint found');
}

const transaction = await coco.wallet.preparePaymentRequestTransaction(mintUrl, prepared);

// Use this mint for the payment
await coco.wallet.handleHttpPaymentRequest(transaction);
```

## Error Handling

Payment request operations can throw errors in several cases:

```ts
try {
  const prepared = await coco.wallet.processPaymentRequest(paymentRequest);
  const transaction = await coco.wallet.preparePaymentRequestTransaction(mintUrl, prepared);
  await coco.wallet.handleHttpPaymentRequest(transaction);
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
  const prepared = await coco.wallet.processPaymentRequest(paymentRequest);

  // 2. Pick a suitable mint
  const mintUrl = prepared.matchingMints[0];

  if (!mintUrl) {
    throw new Error('No suitable mint with sufficient balance');
  }

  // 3. Prepare the transaction
  const transaction = await coco.wallet.preparePaymentRequestTransaction(mintUrl, prepared);

  // 4. Handle based on transport type
  if (prepared.transport.type === 'http') {
    const response = await coco.wallet.handleHttpPaymentRequest(transaction);
    return { success: response.ok, response };
  }

  if (prepared.transport.type === 'inband') {
    let deliveredToken;
    await coco.wallet.handleInbandPaymentRequest(
      transaction,
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

