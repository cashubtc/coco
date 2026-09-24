# Cashu payment requests

Use `coco.paymentRequests` for NUT-18 requests. These carry ecash payment requirements and a
transport; they are distinct from BOLT11 invoices and BOLT12 offers.

## Pay a request

Parse the request and choose from `payableMints`, which applies trust, balance, unit, allowed-mint,
and supported spending-condition checks. Show any `spendingCondition` diagnostic when there is
no eligible mint. A request's `allowedMints` alone is not a list of payable choices.

```ts
const request = await coco.paymentRequests.parse(encodedRequest);
if (!request.payableMints.includes(mintUrl)) throw new Error('Choose a payable mint');
if (request.transport.type === 'nostr') {
  throw new Error('Route Nostr delivery through a transport plugin');
}
const prepared = await coco.paymentRequests.prepare(request, {
  mintUrl,
  amount: request.amount === undefined ? { amount: 100, unit: request.unit } : undefined,
});
// Retain prepared.sendOperation.id; review requirements, transport destination, and fees.
// After user confirmation:
const result = await coco.paymentRequests.execute(prepared);
```

The example supplies 100 units for an amountless request; use the app's validated amount input.
An embedded amount is exact and must not be overridden with a different amount or unit.

For `result.type === 'inband'`, the app delivers `result.token`; encode it with
`coco.wallet.encodeToken()` for a text or QR transport. For HTTP, Coco submits the token to the
request's destination; check `result.response.ok`. Delivery acknowledgement is distinct from
recipient claim: the underlying Send Operation remains the authority for settlement.

If HTTP delivery fails after token creation, retain and reconcile `prepared.sendOperation.id`.
Apply the [send lifecycle](ecash-send.md) to cancellation, pending value, and reclaim; sending a
fresh payment after a transport error can pay twice. For Nostr, establish the plugin's delivery
path before preparation; core parses that transport but does not execute its delivery itself.

## Create a request and claim an incoming payload

```ts
const request = await coco.paymentRequests.incoming.create({
  amount: 100,
  unit: 'sat',
  mints: [mintUrl],
  description: 'Coffee',
  singleUse: true,
});
const requestToDisplay = request.encodedRequest;
// When the app's inband transport receives a payload:
const result = await coco.paymentRequests.incoming.claimPayload(request.id, encodedPayload, {
  transport: 'inband',
  transportMessageId: messageId,
});
```

Requests are active immediately. Retain `request.id` and a stable transport message ID for
redelivery; Coco validates and deduplicates payloads through the incoming request flow. Resume
with `incoming.get(id)` / `incoming.list()`. Use `incoming.cancel(id)` to stop accepting future
payloads; cancellation is not reversal of previously received value.

Nostr receiving also requires a transport plugin to create the descriptor and ingest payloads.
Incoming request creation with `nut10` and receiver-side enforcement of that requirement are not
supported by core. Payer-side P2PK requirements are supported: read [P2PK](p2pk.md) when the
parsed request carries one.

**Done when:** the chosen mint and amount satisfy the request, delivery and settlement are shown
separately, and redelivered payloads or lost delivery responses do not create duplicate payments.

See [Payment Requests](https://cashubtc.github.io/coco/starting/payment-requests) for transport
integration details.
