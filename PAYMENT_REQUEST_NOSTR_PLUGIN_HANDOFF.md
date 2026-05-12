# Payment Request Nostr Plugin Handoff

## Purpose

This document hands off the Nostr-specific payment-request work to an external
plugin agent. Core is now ready for a Nostr transport plugin: it owns the durable
incoming payment-request saga, idempotency, single-use enforcement, child receive
operations, recovery, and history linkage. The plugin should own Nostr signing,
relay/subscription lifecycle, NIP-17 wrapping/unwrapping, NUT-18 event delivery,
and app-facing Nostr ergonomics.

The intended boundary is:

- Core decides whether money was received or paid.
- Core persists request and attempt state.
- Core validates payload/request/mint/amount constraints.
- The plugin creates Nostr transport descriptors and moves encrypted messages
  over relays.
- The plugin never treats relay delivery as settlement.

## Core Baseline

Incoming payment-request API:

```ts
manager.paymentRequests.incoming.create(input);
manager.paymentRequests.incoming.activate(operationOrId);
manager.paymentRequests.incoming.cancel(operationId, reason?);
manager.paymentRequests.incoming.get(operationId);
manager.paymentRequests.incoming.list(filter?);
manager.paymentRequests.incoming.ingestPayload(payload, source?);
manager.paymentRequests.incoming.recovery.run();
manager.paymentRequests.incoming.diagnostics.isLocked(operationId);
```

Services exposed through `ServiceMap` include:

```ts
paymentRequestReceiveService;
paymentRequestService;
sendOperationService;
proofService;
eventBus;
logger;
```

Core receive service now also exposes:

```ts
const unregister = paymentRequestReceiveService.registerTransportHandler(handler);
```

The handler is intentionally narrow:

```ts
export interface PaymentRequestReceiveTransportHandler {
  readonly type: 'nostr' | 'post';
  createRequestTransport?(
    input: PaymentRequestReceiveTransportCreateInput,
  ): PaymentRequestTransport;
  activate?(operation: PaymentRequestReceiveOperation): Promise<void> | void;
  deactivate?(operation: PaymentRequestReceiveOperation): Promise<void> | void;
}
```

Register one handler for `type: 'nostr'` during plugin startup and call the
returned `unregister` function during plugin teardown.

## Incoming Request Flow

The plugin should register a transport handler that converts a core request into
a Cashu NUT-18 Nostr transport descriptor:

```ts
import { PaymentRequestTransportType } from '@cashu/cashu-ts';

const unregister = paymentRequestReceiveService.registerTransportHandler({
  type: 'nostr',

  async createRequestTransport(input) {
    const pubkey = await signer.getPublicKey();
    const target = encodeNprofile({
      pubkey,
      relays: resolveInboxRelays(input),
    });

    return {
      type: PaymentRequestTransportType.NOSTR,
      target,
      tags: [['n', '17']],
    };
  },

  async activate(operation) {
    await nostrSubscriptions.activatePaymentRequest(operation);
  },

  async deactivate(operation) {
    await nostrSubscriptions.deactivatePaymentRequest(operation.id);
  },
});
```

Then the app-facing plugin API can create an incoming Nostr payment request
through core directly. `create()` activates the operation by default, so the
plugin does not need a second activation call in the normal path:

```ts
const operation = await paymentRequestReceiveService.create({
  amount,
  unit: 'sat',
  mints,
  requestId,
  description,
  singleUse: true,
  transport: 'nostr',
  encoding: 'creqB',
});

return {
  operation,
  encodedRequest: operation.encodedRequest,
};
```

Core will persist `operation.transport === 'nostr'` and encode the returned
Nostr descriptor into the Cashu payment request, then call the registered
transport handler's `activate(operation)` hook. The plugin no longer needs to
create an in-band request and a separate plugin-owned encoded request.

If the plugin needs to prepare a request without subscribing yet, opt into draft
creation explicitly:

```ts
const draft = await paymentRequestReceiveService.create({
  amount,
  mints,
  transport: 'nostr',
  activate: false,
});

await paymentRequestReceiveService.activate(draft.id);
```

Core also accepts a direct descriptor for tests or advanced callers:

```ts
await paymentRequestReceiveService.create({
  amount,
  mints,
  transport: {
    type: PaymentRequestTransportType.NOSTR,
    target: nprofile,
    tags: [['n', '17']],
  },
});
```

## Incoming Event Ingest

For every decrypted NIP-17 event containing a `PaymentRequestPayload`, call core
with the raw JSON or parsed payload:

```ts
await paymentRequestReceiveService.ingestPayload(payloadJson, {
  transport: 'nostr',
  transportMessageId: giftWrapEvent.id,
  senderPubkey,
});
```

Core will:

- parse the payload with integer-safe handling,
- look up the request by payload `id`,
- dedupe by `transportMessageId`,
- dedupe redelivered payloads by request id and canonical payload hash, even
  after a single-use request has completed,
- reject reused Nostr event ids that point at a different request operation,
- validate request id, mint, unit, gross amount, trusted mint, and unsupported
  NUT-10 requirements,
- enforce single-use requests while a previous claim is in flight,
- create and execute a child receive operation,
- finalize or reject the attempt,
- complete the parent operation for single-use requests,
- persist receive source metadata for history.

The plugin should not call `claimPayload()` directly unless it has already
resolved a specific operation. `ingestPayload()` is the payload-only ingress path
for relay delivery.

## Recovery Contract

Core calls registered transport handlers during
`paymentRequestReceiveService.recoverPendingAttempts()`:

- active Nostr operations call `handler.activate(operation)`;
- interrupted receive attempts are reconciled;
- already-finalized attempts complete active single-use parents;
- child receive recovery remains owned by core.

The plugin's `activate()` must be idempotent. Startup may call it for operations
that were already subscribed before the process crashed.

If an active Nostr operation exists but no Nostr handler is registered, core
cannot safely recover the transport subscription and will throw. Apps that use
Nostr payment requests should install the plugin before running manager startup
recovery.

## Outgoing Nostr Payment Flow

Core can now parse Nostr payment-request transports:

```ts
const resolved = await paymentRequestService.parse(encodedRequest);

if (resolved.transport.type === 'nostr') {
  // Plugin owns transport delivery.
}
```

Core intentionally does not execute Nostr delivery itself:

```ts
await paymentRequestService.execute(prepared);
// Throws: Nostr payment request execution requires a transport plugin
```

The plugin should implement outgoing payment like this:

1. Parse the encoded request with `paymentRequestService.parse(encodedRequest)`.
2. Require `resolved.transport.type === 'nostr'`.
3. Prepare the send through `paymentRequestService.prepare(resolved, options)`.
4. Execute the underlying send operation through `sendOperationService`.
5. Build a NUT-18 `PaymentRequestPayload` with the request id, token mint, unit,
   proofs, and memo.
6. Deliver the payload to the receiver using NIP-17/Nostr.
7. Report send-operation finality from core separately from relay delivery.

The exact send-operation call should follow the plugin's current service access
pattern. Do not duplicate proof selection, swap, fee, or proof persistence logic
in the plugin.

## Suggested Plugin API

Suggested package name:

```text
@cashu/coco-plugin-nostr-payment-requests
```

Suggested public entrypoints:

```ts
export function createNostrPaymentRequestsPlugin(
  options: NostrPaymentRequestsPluginOptions,
): Plugin<[
  'paymentRequestReceiveService',
  'paymentRequestService',
  'sendOperationService',
  'proofService',
  'logger',
]>;

export interface NostrPaymentRequestsApi {
  createRequest(input: CreateNostrPaymentRequestInput): Promise<NostrPaymentRequestCreated>;
  activateRequest(operationId: string): Promise<void>;
  deactivateRequest(operationId: string): Promise<void>;
  payRequest(input: PayNostrPaymentRequestInput): Promise<NostrPaymentRequestPaymentResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Register the extension as:

```ts
ctx.registerExtension('nostrPaymentRequests', api);
```

Apps can then call:

```ts
await manager.ext.nostrPaymentRequests.createRequest(...);
await manager.ext.nostrPaymentRequests.payRequest(...);
```

Use module augmentation in the plugin package so app code gets typed access to
`manager.ext.nostrPaymentRequests`.

Recommended plugin options:

```ts
export interface NostrPaymentRequestsPluginOptions {
  signer: NostrSigner;
  relays: {
    inbox: string[];
    publish?: string[];
    discovery?: string[];
  };
  publishInboxRelayList?: boolean;
  requestDefaults?: {
    encoding?: 'creqA' | 'creqB';
    singleUse?: boolean;
  };
  clock?: () => number;
}

export interface NostrSigner {
  getPublicKey(): Promise<string>; // x-only hex pubkey
  signEvent(event: UnsignedNostrEvent): Promise<NostrEvent>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
}
```

Keep key custody app-owned. A local private-key signer is fine for tests, but the
public API should accept an injected signer.

## Nostr Responsibilities

The plugin should implement:

- nprofile target creation from receiver pubkey and relay hints,
- relay connection lifecycle,
- subscription lifecycle for active receive operations,
- optional inbox relay list publication if the app opts in,
- NIP-17 wrapping and unwrapping,
- NIP-44 encryption/decryption through the injected signer where possible,
- event validation before forwarding payloads to core,
- replay handling at the relay layer without bypassing core idempotency,
- app-facing status/events for relay delivery and subscription health.

Treat Nostr event metadata as transport metadata. It can be useful for audit and
UI, but it must not become the source of truth for payment state.

## Current Constraints

The plugin must respect current core constraints:

- incoming request receives are `sat`-only,
- incoming NUT-10 receive requirements are rejected,
- DLEQ-required policy is not implemented in the incoming receive saga,
- core does not bundle Nostr dependencies,
- core does not publish to or subscribe from relays,
- core outgoing `execute()` does not deliver Nostr payloads.

The plugin should not advertise unsupported receive policies in generated
requests. Keep the first plugin slice Nostr-transport-only.

## Required Plugin Tests

At minimum, cover:

- registering and unregistering the Nostr transport handler,
- creating an incoming request with `transport: 'nostr'`,
- encoded request contains the expected Nostr transport descriptor,
- `activate()` subscribes idempotently,
- `deactivate()` unsubscribes idempotently,
- redelivered Nostr event id returns the existing core attempt,
- redelivered payload after single-use completion returns the finalized core
  attempt,
- different payload using the same Nostr event id is rejected by core,
- startup recovery reactivates subscriptions for active Nostr operations,
- outgoing Nostr request parse/prepare/send/deliver flow keeps core send finality
  separate from relay publication.

Core has focused tests for the receive-service transport seam, idempotency, and
recovery behavior; plugin tests should prove the Nostr implementation exercises
that seam correctly.
