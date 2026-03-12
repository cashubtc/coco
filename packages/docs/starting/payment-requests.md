# Payment Requests

Payment requests (NUT-18) provide a standardized way to request payments in Cashu. A payment request encodes information about the requested payment, including the amount, allowed mints, and how the tokens should be delivered.

## Reading a Payment Request

To handle a payment request, first parse it using `paymentRequests.parse()`:

```ts
const paymentRequest = 'creqA...'; // encoded payment request

const prepared = await coco.paymentRequests.parse(paymentRequest);

console.log('Transport:', prepared.transport.type);
console.log('Amount:', prepared.amount);
console.log('Allowed mints:', prepared.allowedMints);
console.log('Matching mints:', prepared.payableMints);
```

The returned `ResolvedPaymentRequest` contains:

- **transport** - How to deliver the tokens (`inband` or `http`)
- **amount** - The requested amount (optional, but required for payment)
- **allowedMints** - List of allowed mints from the request
- **payableMints** - Trusted mints with sufficient balance

## Transport Types

Payment requests specify how tokens should be delivered:

### Inband Transport

With inband transport, your application handles the token delivery. This is useful for QR codes, NFC, messaging apps, or any custom delivery mechanism.

```ts
const prepared = await coco.paymentRequests.parse(paymentRequest);

if (prepared.transport.type === 'inband') {
  const transaction = await coco.paymentRequests.prepare(prepared, {
    mintUrl: 'https://mint.url',
  });
  const result = await coco.paymentRequests.execute(transaction);

  if (result.type === 'inband') {
    // Your delivery logic here
    // e.g., display as QR code, send via NFC, post to chat
    console.log('Token to deliver:', result.token);
  }
}
```

### HTTP Transport

With HTTP transport, tokens are automatically POSTed to a URL specified in the payment request.

```ts
const prepared = await coco.paymentRequests.parse(paymentRequest);

if (prepared.transport.type === 'http') {
  const transaction = await coco.paymentRequests.prepare(prepared, {
    mintUrl: 'https://mint.url',
  });
  const result = await coco.paymentRequests.execute(transaction);

  if (result.type === 'http' && result.response.ok) {
    console.log('Payment delivered successfully');
  } else {
    console.error('Payment delivery failed');
  }
}
```

## Specifying the Amount

If the payment request doesn't include an amount, you must provide one:

```ts
// Amount from request
const transaction = await coco.paymentRequests.prepare(prepared, { mintUrl });
const result = await coco.paymentRequests.execute(transaction);

// Override or provide amount
const customTx = await coco.paymentRequests.prepare(prepared, { mintUrl, amount: 100 });
const customResult = await coco.paymentRequests.execute(customTx);
```

> **Note:** If the payment request specifies an amount, providing a different amount will throw an error. The requested amount is always exact.

## Choosing a Mint

Payment requests may restrict which mints are acceptable. Verify your chosen mint is allowed:

```ts
const prepared = await coco.paymentRequests.parse(paymentRequest);

// Pick any mint that matches the request
const mintUrl = prepared.payableMints[0];

if (!mintUrl) {
  throw new Error('No suitable mint found');
}

const transaction = await coco.paymentRequests.prepare(prepared, { mintUrl });

// Use this mint for the payment
await coco.paymentRequests.execute(transaction);
```

## Error Handling

Payment request operations can throw errors in several cases:

```ts
try {
  const prepared = await coco.paymentRequests.parse(paymentRequest);
  const transaction = await coco.paymentRequests.prepare(prepared, { mintUrl });
  await coco.paymentRequests.execute(transaction);
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
  const prepared = await coco.paymentRequests.parse(paymentRequest);

  // 2. Pick a suitable mint
  const mintUrl = prepared.payableMints[0];

  if (!mintUrl) {
    throw new Error('No suitable mint with sufficient balance');
  }

  // 3. Prepare the transaction
  const transaction = await coco.paymentRequests.prepare(prepared, { mintUrl });

  // 4. Execute based on transport type
  const result = await coco.paymentRequests.execute(transaction);

  if (result.type === 'http') {
    return { success: result.response.ok, response: result.response };
  }

  if (result.type === 'inband') {
    // Add your delivery logic here
    return { success: true, token: result.token };
  }
}
```
