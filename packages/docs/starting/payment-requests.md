# Payment Requests

Payment requests (NUT-18) provide a standardized way to request payments in Cashu. A payment request encodes information about the requested payment, including the amount, allowed mints, and how the tokens should be delivered.

The examples use an initialized Coco Session with trusted mints. Creating a
request does not issue tokens or create a Lightning invoice: the payer sends
existing ecash, and the receiver claims it through a receive operation.

For HTTP handlers, browser workers, or test drivers, see
[Amounts and JSON boundaries](../pages/amounts-json.md). Send the encoded request
across the boundary and parse it in the session that will prepare the payment.

## Reading a Payment Request

To handle a payment request, first parse it using `paymentRequests.parse()`:

```ts
const paymentRequest = 'creqA...'; // encoded payment request

const prepared = await coco.paymentRequests.parse(paymentRequest);

console.log('Transport:', prepared.transport.type);
console.log('Amount:', prepared.amount);
console.log('Unit:', prepared.unit);
console.log('Allowed mints:', prepared.allowedMints);
console.log('Matching mints:', prepared.payableMints);
```

The returned `ResolvedPaymentRequest` contains:

- **transport** - How to deliver the tokens (`inband`, `http`, or `nostr`)
- **amount** - The requested amount (optional, but required for payment)
- **unit** - The requested unit, normalized to lowercase
- **allowedMints** - List of allowed mints from the request
- **payableMints** - Trusted mints with sufficient balance. For P2PK requests,
  this also requires NUT-11 support.
- **spendingCondition** - Optional NUT-10 requirement details. Valid P2PK
  requirements are exposed as normalized P2PK options; unsupported or malformed
  requirements are exposed as diagnostics.

## P2PK Payment Request Requirements

Payment requests can include a NUT-10 spending condition. Coco currently supports
payer-side NUT-11 P2PK requirements. When `paymentRequests.parse()` sees a valid
P2PK requirement, the resolved request includes normalized P2PK options:

```ts
const prepared = await coco.paymentRequests.parse(paymentRequest);

if (prepared.spendingCondition?.kind === 'P2PK') {
  console.log('P2PK options:', prepared.spendingCondition.p2pk.options);
}
```

For P2PK payment requests, `payableMints` only includes mints that are:

- trusted by this Coco instance
- holding enough spendable balance for the requested unit and amount
- allowed by the payment request's mint list, if present
- advertising NUT-11 support in mint info

If a request contains unsupported NUT-10, HTLC, or malformed P2PK requirements,
`parse()` returns `payableMints: []` and preserves the reason in
`spendingCondition`. `prepare()` also enforces the requirement before creating a
send operation, so funds are not moved for unsupported or malformed requirements.

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

### Nostr Transport

Core can parse Nostr payment-request transports, but relay delivery is owned by an
optional transport plugin. Calling `paymentRequests.execute()` for a Nostr request
throws unless the app routes the prepared send through a plugin.

```ts
const prepared = await coco.paymentRequests.parse(paymentRequest);

if (prepared.transport.type === 'nostr') {
  // Hand this request to the Nostr payment-request plugin.
  console.log(prepared.transport.target);
}
```

## Creating a Payment Request to Receive

Incoming payment requests live under `paymentRequests.incoming`. Created requests are
active immediately. Use `cancel()` to stop accepting future payloads; completed and
cancelled requests remain queryable.

```ts
const request = await coco.paymentRequests.incoming.create({
  amount: 100,
  unit: 'sat',
  mints: ['https://mint.url'],
  description: 'Coffee',
  singleUse: true,
  transport: { type: 'inband' },
  encoding: 'creqB',
});

console.log(request.encodedRequest);
```

`amount` is required and must be positive. `unit` defaults to `sat`; every
explicitly listed mint must already be trusted by the receiving session.
`requestId` is optional (generated when omitted); an explicit ID must be nonblank
and unique among active requests. `description` is optional, `singleUse` defaults
to `true`, and `encoding` defaults to `creqB`.

The transport can be `{ type: 'inband' }` (also the default),
`{ type: 'post', target: 'https://receiver.example/payments' }`, or
`{ type: 'nostr', target: recipientPublicKey, tags: [['relays', relayUrl]] }`.
Both `post` and `nostr` incoming transports require a registered transport
handler plugin, including when you supply the descriptor object. The Nostr
handler owns subscription/decryption; a post handler must integrate your HTTP
endpoint because core does not host it. A registered handler can also construct its descriptor
when passed `transport: 'nostr'` or `transport: 'post'`.

`creqB` uses a Bech32 encoding with a 1,023-character encoded-request limit in the
current encoder. This is a limit on the whole encoded request, not a description
character limit: Unicode, mint URLs, and transport fields all contribute.
Oversized requests throw `PaymentRequestError` with the encoder error as `cause`.
Shorten the fields, or explicitly use `encoding: 'creqA'` when the payer supports
it. Coco does not silently truncate fields or change encodings. Encoding fails
before the incoming request is persisted.

Bare incoming request amounts default to sats. For custom units, pass the
amount and unit together or provide an explicit `unit`:

```ts
const usdRequest = await coco.paymentRequests.incoming.create({
  amount: { amount: 5, unit: 'usd' },
  mints: ['https://mint.url'],
});
```

For in-band delivery, receive a `PaymentRequestPayload` from your own transport and
claim it against the request:

```ts
const result = await coco.paymentRequests.incoming.claimPayload(request.id, payload, {
  transport: 'inband',
  transportMessageId: messageId,
});

console.log(result.operation.state);
```

For Nostr delivery, install a Nostr payment-request plugin. The plugin registers the
transport handler that creates the Nostr descriptor, subscribes to relays, decrypts
incoming events, and calls `ingestPayload()`:

```ts
await coco.paymentRequests.incoming.create({
  amount: 100,
  mints: ['https://mint.url'],
  transport: 'nostr',
});
```

Core then validates the payload, deduplicates redeliveries, runs the normal receive
operation, and completes the request if it is single-use.

Incoming payment request creation with `nut10` is not supported yet. Receiver-side
validation of incoming payloads against a request's `nut10` requirement is also
out of scope for core today.

## Complete Inband Round Trip

This function takes two initialized sessions for separate wallets. Both trust the
selected mint, and the payer already has sufficient spendable `sat` balance,
including any fees. The application transports the encoded request to the payer
and the returned payload to the receiver; passing objects directly here keeps the
example independent of a particular HTTP or QR library.

```ts
import type { Manager } from '@cashu/coco-core';

async function payAndClaim(receiver: Manager, payer: Manager, mintUrl: string) {
  const incoming = await receiver.paymentRequests.incoming.create({
    amount: 10,
    unit: 'sat',
    mints: [mintUrl],
    description: 'Coffee',
    singleUse: true,
    transport: { type: 'inband' },
    encoding: 'creqB',
  });

  const resolved = await payer.paymentRequests.parse(incoming.encodedRequest);
  const payableMint = resolved.payableMints[0];
  if (!payableMint) throw new Error('No trusted mint with sufficient balance');

  const prepared = await payer.paymentRequests.prepare(resolved, { mintUrl: payableMint });
  const paid = await payer.paymentRequests.execute(prepared);
  if (paid.type !== 'inband') throw new Error('Expected inband delivery');

  const payload = {
    id: incoming.requestId,
    mint: paid.token.mint,
    unit: paid.token.unit ?? 'sat',
    proofs: paid.token.proofs,
  };
  const claim = await receiver.paymentRequests.incoming.claimPayload(incoming.id, payload, {
    transport: 'inband',
    transportMessageId: paid.operation.id,
  });
  console.log('Request:', claim.operation.state, 'Attempt:', claim.attempt.state);
  return claim;
}
```

Check both the request and attempt state: a rejected claim can be returned as a
recorded `rejected` attempt instead of throwing. Store the incoming operation ID
for `incoming.get(id)`, `incoming.cancel(id, reason)`, and later UI refreshes.
`incoming.list({ state: 'active' })` finds active requests. The request ID carried
in the payload (`requestId`) is distinct from the local incoming operation `id`.
For payloads routed by their embedded request ID, use `incoming.ingestPayload()`.

Incoming request claims deduplicate redelivered payloads. This is separate from
[raw token receive preparation](../pages/receive-operations.md#repeated-tokens-and-failed-execution),
which can create another attempt for a previously completed token. A successful
outgoing inband execution means the token is ready to deliver, not that the
receiver has claimed it. HTTP execution posts the token object to the target;
your endpoint must associate it with the incoming request and construct/claim a
`PaymentRequestPayload` with its required unit and request ID as appropriate.

## Specifying the Amount

If the payment request doesn't include an amount, you must provide one:

```ts
// Amount from request
const transaction = await coco.paymentRequests.prepare(prepared, { mintUrl });
const result = await coco.paymentRequests.execute(transaction);

// Provide an amount when omitted, or repeat the exact requested amount
const customTx = await coco.paymentRequests.prepare(prepared, { mintUrl, amount: 100 });
const customResult = await coco.paymentRequests.execute(customTx);
```

For custom-unit requests without an embedded amount, provide the amount and unit
together:

```ts
const customUnitTx = await coco.paymentRequests.prepare(prepared, {
  mintUrl,
  amount: { amount: 5, unit: prepared.unit },
});
```

> **Note:** If the payment request specifies an amount or unit, providing a different amount or unit will throw an error. The requested amount is always exact.

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

For P2PK requests, do not choose from `allowedMints` directly. Use
`payableMints`, because it also applies the NUT-11 mint capability check.

## Error Handling

Malformed encoded requests and incoming encoding failures throw the exported
`PaymentRequestError`, preserving low-level decoder/encoder failures in `cause`.
Other validation paths retain their domain errors: invalid numeric amounts can
throw `AmountError`, and invalid units can throw `UnitValidationError`. Raw token
and key import validation use their own errors. Catch `unknown` at your app
boundary instead of assuming every rejection has one constructor or message.

```ts
import { PaymentRequestError } from '@cashu/coco-core';

try {
  await coco.paymentRequests.parse(paymentRequest);
} catch (error) {
  if (error instanceof PaymentRequestError) {
    console.error(error.message, error.cause);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
```

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
  // - Unsupported or malformed NUT-10 requirement
  // - Selected mint does not advertise NUT-11 for a P2PK request
  console.error('Payment failed:', error instanceof Error ? error.message : error);
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
