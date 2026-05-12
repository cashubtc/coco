# Receiving Cashu Payment Requests

## Purpose

Coco already supports paying Cashu payment requests by parsing NUT-18/NUT-26 request
strings, preparing a send operation, and delivering the resulting token either in-band or
by HTTP POST. The missing half is receiver-initiated payment requests: Coco should be
able to create a payment request, wait for a `PaymentRequestPayload`, and claim the
payload through the same crash-safe receive saga used by ordinary token receives.

This plan adds receiving support without weakening the current operation model:

- Request creation is tracked as its own durable incoming-payment-request saga.
- Each incoming payload is claimed through a normal `ReceiveOperationService` child
  operation.
- Nostr is the first transport, preferably using NUT-18's NIP-17 direct-message path.
- Core remains usable without a Nostr dependency; the Nostr relay/key work is an
  adapter/plugin around a core transport interface.

## Current Coco Receive Architecture

Token receives are already operation-first:

1. `ReceiveOpsApi.prepare({ token })` calls `ReceiveOperationService.init(token)`.
2. `init()` extracts and normalizes the mint URL, requires the mint to be trusted,
   decodes the token, enforces the current `sat`-only receive guard, prepares incoming
   proofs for receiving, sums proof amounts, creates a `ReceiveOperation` in `init`, and
   persists it.
3. `prepare()` reloads the operation, computes receive fees with the active wallet,
   creates deterministic output data for the net keep amount, persists `prepared`, and
   emits `receive-op:prepared`.
4. `execute()` persists `executing` before mint interaction, calls `wallet.receive(...)`
   with the stored deterministic output data, saves the new proofs with
   `createdByOperationId`, persists `finalized`, and emits `receive-op:finalized`.
5. Terminal mint-originated failures are rolled back through `receive-op:rolled-back`.
   Non-terminal or ambiguous failures remain `executing` so startup recovery can use
   `outputData`.
6. Startup recovery cleans up stale `init`, leaves `prepared` for user action, and
   reconciles `executing` by checking input proof states. If inputs are spent, it
   recovers proofs from `outputData`; if inputs are unspent, it re-executes; otherwise it
   retries later.
7. `HistoryService` intentionally ignores `receive-op:prepared`. User-facing receive
   history is created or updated only from `receive-op:finalized` and
   `receive-op:rolled-back`.

The important invariant is that a receive only becomes user-facing when Coco has either
finalized it or intentionally rolled it back. Payment-request receiving should preserve
that boundary.

## Spec Constraints

Sources:

- NUT-18 Payment Requests: https://cashubtc.github.io/nuts/18/
- NUT-26 Payment Request Bech32m Encoding: https://cashubtc.github.io/nuts/26/
- NIP-17 Private Direct Messages: https://nips.nostr.com/17

Relevant NUT-18 behavior:

- A receiver creates a request, displays or shares it, the sender constructs a matching
  token, delivers it through the request transport, and the receiver finalizes the
  transaction.
- Request fields include payment id `i`, amount `a`, unit `u`, single-use flag `s`,
  allowed mints `m`, description `d`, transports `t`, and optional `nut10` locking
  requirements.
- Transport may be empty, which means delivery is in-band by the surrounding protocol.
- Nostr transport uses type `nostr`, target `nprofile`, and tags such as `[["n", "17"]]`.
  For NIP-17, the sender sends the `PaymentRequestPayload` as the direct-message content.
- The payload is JSON with optional `id` and `memo`, plus required `mint`, `unit`, and
  `proofs`.
- The payee is responsible for validating incoming proofs, including DLEQ and required
  locking conditions.

Relevant NUT-26 behavior:

- `creqb1...` is the compact TLV plus Bech32m encoding of a NUT-18 payment request.
- Implementations should parse both `creqA...` and `creqb1...`/`CREQB1...`.
- Nostr TLV target encoding stores the raw 32-byte x-only pubkey and can round-trip
  relay hints as tag tuples. This is compatible with exposing a NUT-18 `nprofile`.
- NUT-26 currently describes the Nostr transport kind as NIP-04 in one table, while
  NUT-18 says the Nostr `n` tag declares supported NIPs and explicitly describes NIP-17.
  Coco should follow NUT-18 for new receive support and encode `n=17` when advertising
  Nostr receive capability.

Relevant NIP-17 behavior:

- The user-visible message is an unsigned kind 14 rumor.
- It is sealed with NIP-44, then gift-wrapped in kind 1059 events.
- Gift wraps are published to the receiver's kind 10050 inbox relay list when available.
- The receiver must unwrap, verify the seal sender matches the rumor sender, parse the
  kind 14 content, and then hand the payload to Coco.

## Design Overview

Do not model the payment request itself as a plain receive operation. At request creation
time there are no proofs, no mint interaction, and no deterministic receive outputs yet.
Instead add an incoming payment-request saga that owns request lifecycle and delegates
payload claiming to `ReceiveOperationService`.

Proposed relationship:

```text
PaymentRequestReceiveOperation
  id: local saga id
  requestId: NUT-18 payment id (`i`)
  encodedRequest: creqA or CREQB
  state: active | completed | cancelled | expired
  transport: inband | nostr | post
  amount/unit/mints/singleUse/description/nut10
  children: PaymentRequestReceiveAttempt[]

PaymentRequestReceiveAttempt
  id: local attempt id
  requestOperationId
  requestId
  transportMessageId: nostr event id, HTTP delivery id, or caller-provided id
  payloadHash
  senderPubkey?
  memo?
  mint/unit/grossAmount/netAmount?
  receiveOperationId?
  state: received | validating | receiving | finalized | rejected | duplicate
```

The child `ReceiveOperation` remains the source of truth for mint interaction, output
recovery, and wallet proof persistence. The request saga tracks why that receive exists
and whether the request can accept more payloads.

## Data Model Changes

Add core models:

- `PaymentRequestReceiveOperation`
- `PaymentRequestReceiveAttempt`
- `PaymentRequestReceiveState`
- `PaymentRequestReceiveAttemptState`
- `PaymentRequestReceiveSource`

Add repositories:

- `PaymentRequestReceiveOperationRepository`
- `PaymentRequestReceiveAttemptRepository`

Repository requirements:

- Create/update/get by local operation id.
- Get active requests by request id.
- Get attempts by request operation id.
- Get attempt by transport message id.
- Get attempt by payload hash.
- Transactionally create an attempt and link it to a child receive operation.
- Enforce uniqueness on transport message id when present.
- Enforce idempotency on `(requestOperationId, payloadHash)`.

Adapter work:

- Memory repository first.
- SQLite3, sqlite-bun, Expo SQLite, and IndexedDB schema migrations.
- Adapter contract tests for active lookup, idempotent attempts, single-use locking, and
  recovery-state round trips.

Extend `ReceiveOperation` with an optional source field:

```ts
type ReceiveOperationSource =
  | { type: 'manual-token' }
  | {
      type: 'payment-request';
      requestOperationId: string;
      requestId?: string;
      attemptId: string;
      transport: 'inband' | 'nostr' | 'post';
      transportMessageId?: string;
      senderPubkey?: string;
      memo?: string;
    };
```

Persist this as `sourceJson` in receive-operation adapters. Existing rows should read as
`manual-token` or `undefined` without migration churn beyond adding the nullable column
or IndexedDB field.

History:

- Keep normal receive history creation on `receive-op:finalized` and
  `receive-op:rolled-back`.
- Include source metadata in receive history `metadata` so UI can show that a receive
  came from a payment request and can link back to the request saga.
- Do not create user-facing history at request creation or at payload arrival.

## Coordination With Multi-Unit Work

This feature should not block on the custom-unit branch, but the first implementation
should avoid hard conflicts with it:

- Default incoming request `unit` to `sat` at the API boundary.
- Persist `unit` explicitly on the new payment-request receive operation and attempt
  rows, even while only `sat` is accepted.
- Reuse the existing receive-side `sat` guard instead of changing it in this feature.
- Keep amount and unit coupled in new APIs, matching the intended multi-unit direction:
  `{ amount, unit }`.
- Prefer linking attempts to child receives through `attempt.receiveOperationId` in the
  new request-attempt repository for the first slice.
- Defer adding optional `ReceiveOperation.source` / `sourceJson` until after the
  multi-unit branch lands if that branch is actively editing receive-operation models or
  adapter schemas.
- When `sourceJson` is deferred, derive request context by querying the attempt table by
  `receiveOperationId`; this keeps the core receive operation shape untouched.

With that sequencing, the only unavoidable overlap is validation behavior around
non-`sat` payloads. That should be a small guard removal or replacement once custom-unit
support lands, not a structural rewrite.

## API Shape

Keep existing outgoing payment-request methods working:

- `manager.paymentRequests.parse(...)`
- `manager.paymentRequests.prepare(...)`
- `manager.paymentRequests.execute(...)`

Add an incoming namespace to avoid overloading the outgoing names:

```ts
manager.paymentRequests.incoming.create(input)
manager.paymentRequests.incoming.cancel(operationId, reason?)
manager.paymentRequests.incoming.get(operationId)
manager.paymentRequests.incoming.list(filter?)
manager.paymentRequests.incoming.claimPayload(operationOrId, payload, source?)
manager.paymentRequests.incoming.ingestPayload(payload, source?)
manager.paymentRequests.incoming.recovery.run()
manager.paymentRequests.incoming.diagnostics.isLocked(operationId)
```

`create(input)`:

- Validates amount/unit/mint constraints.
- Generates a unique request id unless the caller supplies one.
- Builds `PaymentRequest` with requested fields.
- Encodes to `CREQB` by default for QR efficiency, with `creqA` as an option.
- Persists the request operation as active.
- Starts registered transport listener state before returning.
- Returns the operation and encoded request.

`claimPayload(operationOrId, payload, source?)`:

- Parses and normalizes a `PaymentRequestPayload` with the same integer-safe JSON handling
  used by outgoing HTTP delivery.
- Creates a durable attempt.
- Validates request id, mint, unit, gross proof amount, single-use state, and locking
  requirements before mint interaction.
- Creates a child receive operation with `source.type = 'payment-request'`.
- Prepares the child receive to compute fees and deterministic outputs.
- Executes the child receive.
- Marks the attempt finalized or rejected.
- Marks the request completed if it is single-use and the child receive finalized.

`recovery.run()`:

- Restarts active transport listeners.
- Reconciles attempts whose child receive operation exists.
- Replays attempts stuck before child receive creation if the full payload was persisted,
  or marks them rejected if only incomplete metadata is available.
- Defers to `manager.ops.receive.recovery.run()` for child receive execution recovery.

## Payload Validation Rules

Validation should be stricter than outgoing parsing because this path credits wallet
balance:

1. Request id:
   - If the request has `i`, payload `id` must match.
   - If the request omits `i`, only explicit local operation selection can claim it.
2. Mint:
   - Payload `mint` must be normalized.
   - Payload mint must be trusted.
   - If request `m` is non-empty, payload mint must be in it.
3. Unit:
   - Payload unit must match request unit when request unit is set.
   - For the first implementation, reject non-`sat`, matching current
     `ReceiveOperationService` behavior.
4. Payload parsing:
   - Parse Nostr/HTTP JSON content with integer-safe handling, not plain `JSON.parse`, so
     proof amounts round-trip like outgoing `JSONInt.stringify(token)`.
   - Derive payload hashes from canonical payload content or proof Y values, not raw JSON
     text, because Nostr content and HTTP bodies can vary in field order.
5. Amount:
   - Compute gross payload amount from proofs.
   - Treat the NUT-18 request amount as the gross ecash amount the sender must deliver:
     `grossAmount >= request.amount`.
   - After preparing the child receive, compute and persist receive fee and net credited
     amount for display and reconciliation.
   - Do not reject otherwise valid interoperable payments only because receive fees reduce
     local net balance. If an app needs a strict net-credit guarantee, expose that as an
     explicit Coco policy rather than the default NUT-18 behavior.
   - If a stricter policy rejects after a child receive has already been prepared, roll the
     child receive back with a clear reason. Do not leave a prepared child operation
     dangling.
6. Single-use:
   - A single-use request can have only one finalized attempt.
   - Use a request-level lock so two simultaneous Nostr deliveries cannot both pass the
     single-use check.
7. Duplicate delivery:
   - Duplicate Nostr events or repeated payloads should return the existing attempt
     result without running another receive.
   - Payload hash should be based on canonical payload content or proof Y values, not
     unstable JSON string order.
8. NUT-10:
   - Do not advertise `nut10` receive requirements until validation is implemented.
   - When implemented, validate the incoming proofs satisfy the requested secret kind,
     data, tags, signature/witness requirements, and timelock policy before executing.
   - Existing `ProofService.prepareProofsForReceiving()` can sign supported P2PK proofs,
     but it is not enough by itself to prove the payload matches the request policy.
9. DLEQ:
   - If the request policy requires DLEQ proofs, validate before execution.
   - If DLEQ is absent and policy requires it, reject the attempt.

## Nostr Transport Plan

Core should define a small incoming transport contract:

```ts
interface IncomingPaymentRequestTransport {
  readonly type: 'nostr' | 'post' | 'inband';
  createRequestTransport(input: CreateTransportInput): Promise<PaymentRequestTransport>;
  activate(operation: PaymentRequestReceiveOperation): Promise<void>;
  deactivate(operation: PaymentRequestReceiveOperation): Promise<void>;
}
```

The first implementation should be an optional Nostr plugin/package, not a required core
dependency:

- Depends on `nostr-tools` or a similarly maintained NIP-17 capable library.
- Owns receiver private key access, relay URLs, inbox relay discovery/publication, and
  gift-wrap subscribe/unwrap logic.
- Registers an extension such as `manager.ext.nostrPaymentRequests`.
- Registers a transport handler with `PaymentRequestReceiveService`.
- Emits received payloads into
  `paymentRequestReceiveService.ingestPayload(payload, source)`.

Request creation for Nostr:

- Build a NUT-18 transport with type `nostr`.
- Encode target as `nprofile` containing the receiver pubkey and relay hints.
- Include tags `[["n", "17"]]`.
- Publish or refresh the NIP-17 kind 10050 inbox relay list when the plugin owns the
  receiver key. If the app owns relay publication, make activation fail loudly unless the
  app confirms a usable inbox relay list exists.
- Default to `CREQB` output for QR codes while keeping `creqA` support.

Receiving Nostr payloads:

1. Subscribe to configured inbox relays for kind 1059 gift wraps addressed to the
   receiver pubkey.
2. Unwrap NIP-17 events and verify the kind 13 seal sender matches the kind 14 rumor
   sender.
3. Parse kind 14 content as `PaymentRequestPayload` JSON.
4. Use core ingestion to find the active request operation by payload `id`.
5. Call core `ingestPayload(...)` with source `{ transport: 'nostr', transportMessageId: eventId, senderPubkey }`.
6. Persist relay/event metadata only as metadata. The proofs and mint interaction remain
   in the child receive operation.

Security stance:

- Do not mark requests paid based on Nostr delivery alone.
- Do not trust sender pubkey for payment validity.
- Deduplicate Nostr event ids and payload hashes.
- Bound retained raw payload data. Prefer storing canonical payload hashes and child
  receive operation ids after the receive operation is durably created.

## Saga State Transitions

Incoming request operation:

```text
active -> completed
  |          ^
  |          |
  +-> expired+
  |
  +-> cancelled
```

Attempt:

```text
received -> validating -> receiving -> finalized
    |            |           |
    +------------+-----------+-> rejected
    |
    +-> duplicate
```

Child receive operation:

```text
init -> prepared -> executing -> finalized
  |        |          |
  +--------+----------+-> rolled_back
```

Parent/child consistency:

- Parent `completed` requires at least one finalized child attempt.
- Single-use parent completion is terminal.
- Multi-use parent remains `active` after each finalized attempt.
- Parent cancellation stops new attempts but must not mutate already finalized child
  receives.
- Expiration stops new attempts but does not roll back an executing child receive.

## Recovery Cases

Crash after request create:

- Created requests are active and recovered as active requests.
- Recovery restarts the transport listener for `active` requests.

Crash after Nostr event received but before child receive creation:

- If full payload was stored, retry validation and child creation.
- If only event metadata was stored, mark attempt rejected as incomplete and wait for
  relay redelivery.

Crash after child receive `init` or `prepared`:

- Existing receive recovery handles `init` cleanup and leaves `prepared` for action.
- Incoming-request recovery should either resume the child receive automatically for
  attempts it owns or mark the attempt `rejected` if policy validation cannot be
  reproduced.

Crash after child receive `executing`:

- Existing receive recovery reconciles proofs from mint state and `outputData`.
- Incoming-request recovery should poll the child operation and update attempt/parent
  state when it reaches `finalized` or `rolled_back`.

Crash after child finalized but before parent update:

- Parent recovery scans attempts with finalized child receive operations and marks the
  attempt finalized, then completes the single-use parent if applicable.

Duplicate relay delivery after finalized:

- Request/attempt lookup returns the existing finalized result and does not call the
  mint again.

## Implementation Phases

### Phase 1: Core incoming request saga without live transport

- Add models, repositories, adapters, and contracts.
- Add `PaymentRequestReceiveService`.
- Add `manager.paymentRequests.incoming`.
- Implement create, cancel, list, get, and manual `claimPayload(...)`.
- Extend `ReceiveOperation` source metadata.
- Add unit tests for validation, single-use locking, duplicate payloads, and child
  receive linkage.
- Add adapter contract tests and migration tests.

This phase supports in-band receive of `PaymentRequestPayload` and proves the saga
boundary before adding Nostr complexity.

### Phase 2: Nostr transport plugin

- Add an optional Nostr payment-request plugin/package.
- Implement nprofile/npub parsing and NUT-18 transport creation.
- Implement NIP-17 unwrap and relay subscription.
- Register the transport with the incoming request service.
- Add deterministic tests around handler registration, payload ingestion, duplicate
  event handling, and request lookup.
- Use mocked relay/NIP-17 primitives in core tests; keep live relay tests optional.

### Phase 3: Outgoing Nostr delivery parity

- Extend existing outgoing `PaymentRequestService` to support Nostr transport.
- Reuse the same Nostr plugin transport handler for sending payloads.
- Preserve HTTP and in-band behavior.
- Add outgoing tests for selecting Nostr when preferred and for falling back according
  to transport order.

### Phase 4: Policy hardening

- Implement full NUT-10 validation for payment-request receives.
- Add DLEQ policy checks where requested.
- Revisit multi-unit support once receive is not `sat`-only.
- Add optional expiration and memo display policy.
- Add docs for app developers, including relay privacy and key-management warnings.

## Testing Plan

Core unit tests:

- Creates `CREQB` by default and can create `creqA`.
- Request ids are unique and payload ids must match.
- Claims valid in-band payload through a child receive operation.
- Rejects untrusted mint, wrong mint, wrong unit, under-gross-amount payload, and
  unsupported NUT-10 policy.
- Records receive fee and net credited amount without rejecting valid gross payments.
- Single-use request finalizes once under concurrent duplicate claims.
- Duplicate payload/event returns existing attempt.
- Parent recovery completes after child receive finalizes.

Receive operation tests:

- Source metadata survives memory and persistent repositories.
- History metadata links finalized/rolled-back receives back to request operation ids.
- Existing manual token receive behavior is unchanged.

Adapter tests:

- New repositories round-trip all states.
- Payload hash and transport message ids are unique.
- Schema migrations preserve old receive operations with no source metadata.
- SQLite3, sqlite-bun, Expo SQLite, and IndexedDB agree on state filtering.

Nostr plugin tests:

- Creates NUT-18 Nostr transport with `nprofile` and `n=17`.
- Decodes `CREQB` Nostr targets back to usable pubkey and relays.
- Unwraps a mocked NIP-17 event and calls `ingestPayload`.
- Ignores malformed content.
- Deduplicates event ids.
- Stops subscriptions on pause/dispose.

Docs:

- Add a receive-payment-request guide beside `packages/docs/starting/payment-requests.md`.
- Document incoming vs outgoing payment-request APIs.
- Document that Nostr support requires the optional plugin and receiver key material.

## Open Decisions

- Should incoming requests live only under `manager.paymentRequests.incoming`, or should
  there also be an `manager.ops.paymentRequestReceive` namespace for lifecycle parity
  with mint/send/receive/melt?
- Should rejected payment-request attempts appear in public history, or only in the
  incoming request detail view?
- Should the first Nostr plugin publish kind 10050 automatically, or should apps own
  inbox relay publication?
- Should Coco expose an optional strict net-credit policy for apps that want invoice-like
  guarantees, knowing that default NUT-18 interoperability should validate the gross
  proof amount delivered by the sender?
- Should raw payloads be persisted until finalization for maximum recovery, or should
  Coco store only hashes after child receive creation for lower at-rest sensitivity?

## Recommended First Slice

Start with Phase 1. It gives Coco a durable incoming payment-request model and proves
that payment-request payloads can safely flow through the existing receive saga. Once
that is solid, the Nostr plugin becomes transport plumbing rather than a new money-flow
implementation.
