# Cocod Network Interface v1

Status: accepted and implemented for the authenticated TCP transport, Wallet and Coco Session
lifecycle, Wallet Recovery Material, Cocod Process shutdown, balance resources, and the legacy
compatibility described here. Known Mint resources are also implemented. The complete v1 resource
surface is accepted as the target design; Quote, Operation, Payment Request, history, event, and
machine-description resources remain proposed until their individual contracts and implementations
land.

This document specifies cocod's machine-oriented network interface. It distinguishes implemented
resources from the accepted target surface so resources can land incrementally without inventing
new protocol shapes in each implementation slice.

Normative requirements use **MUST**, **MUST NOT**, **SHOULD**, and **MAY**.

## Goals

- Give local and remote clients one authenticated HTTP interface over TCP.
- Preserve Coco's durable quote and operation lifecycles instead of reducing them to CLI strings.
- Delegate Wallet, Mint, Quote, and Operation state and lifecycle behavior to Coco.
- Make retries, concurrent callers, and process restarts predictable.
- Keep Wallet Seed material and proof-bearing Coco models out of ordinary responses and logs.
- Generate a machine-readable interface description from the schemas used at runtime.

## Non-goals

- Mirroring every method on Coco's `Manager` class.
- Supporting multiple Wallets in one cocod process.
- Identifying or revoking individual Cocod Clients in the first interface version.
- Importing a Wallet from existing Wallet Recovery Material through the network interface.
- Providing native TLS termination.
- Supporting browser clients or defining a CORS policy.
- Preserving the current `{ output }` and `{ error }` response shapes in `/v1` resources.
- Providing durable event replay in the first interface version.
- Mirroring proof-bearing Coco models or repository records directly into network responses.
- Providing one-shot server commands that hide preparation and execution of durable Operations.
- Maintaining cocod-owned copies of Coco resources, public identifier maps, or durable idempotency
  records.
- Adding incoming Payment Request hosting that cocod did not previously expose.
- Migrating the optional NPC extension in this interface version.

## Domain language

The interface uses the [Coco Cashu](../../core/CONTEXT.md) and
[Cocod Host](../CONTEXT.md) glossaries routed by the repository's
[context map](../../../CONTEXT-MAP.md).

**Wallet** is the durable, seed-rooted Cashu holding context. A Wallet continues to exist when cocod
is stopped or its seed is locked.

**Wallet Seed Access** describes whether this cocod process can currently derive Wallet secrets.
It is `locked` or `available`. It is not a client authentication session.

**Wallet Recovery Material** is the human-portable secret from which the Wallet Seed can be
reconstructed. Cocod represents it as a BIP39 mnemonic.

**Coco Session** is a running Coco instance through which cocod uses the Wallet. Cocod owns at most
one Coco Session. Starting or stopping a Coco Session does not create or delete the Wallet.

**Client Credential** authorizes one or more Cocod Clients to call the network interface. In v1,
clients share one administrative credential, so authentication proves owner-level authority rather
than an individual client identity. A Client Credential does not unlock the Wallet Seed and MUST
NOT be treated as Wallet-unlocking material.

The interface deliberately avoids the term "cocod session." It is ambiguous between the Coco
Session and client authentication.

## Process model

One cocod process owns exactly one state directory, listens on one TCP address, and manages zero or
one Wallet. Running multiple Wallets requires multiple cocod processes with distinct state
directories and listener addresses.

Cocod persists only the hosting state needed to run that process: daemon configuration, Client
Credential verification, Wallet configuration and protected recovery material, and process
metadata. Coco and its configured repositories own durable Mint, Quote, Operation, proof, and
history state. The network interface projects that state into safe documents; it does not maintain
a parallel resource store or state machine.

Cocod is downstream of Coco. Its HTTP interface MAY group, rename, or simplify Coco's public
interfaces where that produces a clearer machine interface; it does not need to mirror Manager
methods one for one. Every Wallet-dependent command nevertheless delegates its behavior to a
public Coco interface. When the accepted network interface requires a capability Coco does not yet
expose, that capability MUST land in Coco first. Cocod MUST NOT bypass Coco through direct
repository access or compensate with its own Wallet behavior.

The TCP listener and health endpoint can be available while no Wallet or Coco Session exists.
Wallet-dependent requests require a running Coco Session.

Cocod stores the Wallet mnemonic in its state directory. A passphrase is optional:

- Without a passphrase, the mnemonic is stored without application-level encryption. Access relies
  on the dedicated operating-system user and mode-`0700` state directory. Cocod starts a Coco
  Session without client-supplied unlocking material when the process starts.
- With a passphrase, the mnemonic is encrypted. Cocod starts with Wallet Seed Access locked and
  requires an explicit session-start request after every process restart.

This is an opinionated cocod policy, not an extension interface. "Unattended Coco Session start"
means the behavior when no passphrase is configured; it is not a client or mint login.

```text
client
  |
  | authenticated HTTP
  v
cocod process
  |-- zero or one Wallet
  |-- locked or available Wallet Seed Access
  `-- zero or one running Coco Session
```

## Lifecycle model

Lifecycle is represented by three related facts rather than one combined state.

### Wallet configuration

`wallet` is either `null` or a durable Wallet descriptor. The descriptor MUST NOT contain mnemonic,
seed, proof, or encrypted secret material.

### Wallet Seed Access

When a Wallet exists, `seedAccess.state` is one of:

- `locked`: cocod cannot derive Wallet secrets.
- `available`: cocod can derive Wallet secrets in memory.

`seedAccess` is `null` when no Wallet exists.

`seedAccess.requiresPassphrase` records the configured policy. When it is `false`, Wallet Seed
Access is available whenever the configuration is loaded. When it is `true`, Wallet Seed Access is
locked until a valid session-start request makes it available.

### Coco Session state

`cocoSession.state` is one of:

- `stopped`: no Coco Session exists.
- `starting`: cocod is constructing and recovering a Coco Session.
- `running`: the Coco Session is ready to serve Wallet-dependent requests.
- `stopping`: cocod is disposing the Coco Session.
- `failed`: cocod could not fully clean up a partial or running Coco Session; Wallet-dependent work
  is quarantined until process restart.

The status resource MAY retain a safe `lastFailure` after a failed transition. A failed start
returns to `stopped` when cleanup succeeds and transitions to `failed` when cleanup cannot be
confirmed.

### Invariants

- A missing Wallet implies `seedAccess: null` and `cocoSession.state: stopped`.
- A locked Wallet Seed implies that the Coco Session is not `starting` or `running`.
- A running Coco Session implies a configured Wallet and available Wallet Seed Access.
- A Wallet without a passphrase uses available Wallet Seed Access and starts a Coco Session when
  the cocod process starts.
- A Wallet with a passphrase starts with locked Wallet Seed Access and a stopped Coco Session.
- A failed start MUST attempt to dispose partially acquired resources and restore locked Wallet
  Seed Access when a passphrase is configured.
- A failed Coco Session MUST reject Wallet-dependent work and MUST NOT be restarted in-process.
- Stopping the cocod process MUST attempt to dispose the Coco Session before exit.
- Restarting cocod MUST NOT make passphrase-encrypted Wallet Seed material available automatically.
- Wallet-unlocking material MUST NOT be persisted, logged, returned, or used as a client
  credential.
- The Client Credential alone MUST NOT expose passphrase-encrypted Wallet Recovery Material.
- Retrieving Wallet Recovery Material MUST NOT start or stop a Coco Session or change its state.

### State transitions

```text
No Wallet
   | initialize without passphrase       | initialize with passphrase
   v                                     v
no passphrase                       passphrase configured
+ seed available                      + seed locked
+ session starting                    + session stopped
   |                                     |
   | startup succeeds                    | start session with passphrase
   v                                     v
session running                       seed available + session starting
                                         |
                                         | startup succeeds
                                         v
                                      session running

Any transition whose cleanup cannot be confirmed
   |
   v
Wallet configured + seed state determined by configuration + session failed
   |
   | restart cocod process
   v
normal configuration-specific startup path
```

## Process startup flow

Cocod process startup and Coco Session startup are separate. The process becomes reachable before
an unattended Coco Session finishes starting.

1. Create or verify the mode-`0700` state directory and acquire its exclusive process lease.
   Another process that owns the same state directory makes startup fail before state is loaded.
2. Load and validate daemon configuration and listener security. Load the administrative Client
   Credential, or automatically generate it when no credential exists. Invalid configuration fails
   the process before it binds a network listener.
3. Load and validate the Wallet configuration when present. A missing Wallet is valid; a malformed
   Wallet configuration fails the process before it binds.
4. Bind the TCP listener. `/health` and authenticated `/v1/status` are now available.
5. Choose the Wallet branch:
   - No Wallet: report `wallet: null`, `seedAccess: null`, and `cocoSession.state: stopped`.
   - Passphrase configured: report locked Wallet Seed Access and a stopped Coco Session.
   - No passphrase: make Wallet Seed Access available and transition the Coco Session to
     `starting` without waiting for a client request.
6. While starting a Coco Session, initialize repositories, plugins, Background Watchers, processors,
   and Operation Recovery through `initializeCoco()`.
7. On success, transition the Coco Session to `running`.
8. On failure, dispose partial resources and record `lastFailure`:
   - Confirmed cleanup transitions the session to `stopped`. Cocod does not retry automatically;
     an administrator may retry explicitly or restart the process.
   - Unconfirmed cleanup transitions the session to `failed` and requires process restart.

```text
process start
     |
     v
validate daemon, authentication, and Wallet configuration
     |
     v
bind authenticated TCP listener
     |
     +-- no Wallet ------------> session stopped; wait for initialization
     |
     +-- passphrase configured -> seed locked; session stopped; wait for start request
     |
     `-- no passphrase --------> seed available; session starting
                                      |
                                      +-- success -> session running
                                      |
                                      `-- failure -> session stopped or failed
```

Client Credential provisioning completes before the TCP listener binds. On first start, cocod
generates one opaque, high-entropy bearer credential with `wallet:read` and `wallet:admin`. The
daemon stores only its verifier. The local CLI stores the plaintext credential in a distinct
mode-`0600` client file, from which the Cocod Owner may provision other consumers.

The first interface version has no network credential-management endpoints. Several Cocod Clients
may share the administrative credential, and cocod cannot distinguish them. Credential rotation
is a host-local operation that atomically replaces the verifier and the local client file. Rotation
invalidates every copied credential.

## Transport and authentication

- Cocod MUST listen on TCP and defaults to `127.0.0.1:62626`.
- Listener overrides use `COCOD_LISTEN_HOST` and `COCOD_LISTEN_PORT`. Cocod MUST pass the validated
  host and port explicitly to the HTTP server and MUST NOT inherit generic `PORT` variables.
- Binding to a non-loopback address MUST require explicit configuration.
- Cocod does not terminate TLS in v1. Remote deployments MUST use a trusted TLS proxy such as Caddy.
- A TLS proxy supplies transport security only. Cocod MUST ignore forwarded client-identity headers
  and authenticate the Client Credential itself.
- `GET /health` MUST NOT require a Client Credential and MUST NOT reveal Wallet state.
- Every `/v1/*` request MUST be authenticated.
- Lifecycle mutation requires a client credential with the `wallet:admin` capability.
- Lifecycle status requires at least the `wallet:read` capability.
- The v1 administrative credential has both capabilities.
- Clients send the opaque credential in the `Authorization: Bearer` header.
- Client credentials MUST be read from a mode-`0600` file rather than command arguments.

Authentication proves that the credential bearer has Cocod Owner authority. Because v1 consumers
share one credential, it does not identify which Cocod Client is calling. It also does not by
itself grant Wallet Seed Access.

Browser clients are outside v1 scope. Cocod does not emit permissive CORS headers and clients MUST
NOT expose the shared administrative credential to browser storage or browser application code.

## Legacy command compatibility

The remaining unversioned command routes use the same TCP listener as `/v1`. They retain their
current request and response shapes temporarily so the CLI's send, receive, history, NPC, and
X-Cashu commands remain usable while their v1 resources are implemented. Balance and Known Mint
commands already use v1 resources and their legacy routes have been removed.

Every remaining unversioned route requires the same administrative Client Credential. Cocod does
not run a Unix listener or a second compatibility transport. Later interface revisions replace
these routes incrementally and remove their CLI-oriented response envelopes.

The legacy `/stop` route is not carried forward. The CLI uses the authenticated v1 process-shutdown
resource instead.

## Client endpoint selection

Without an explicit endpoint, the CLI uses `http://127.0.0.1:62626` and may automatically start a
local Cocod Process when it cannot connect. With `--url` or `COCOD_URL`, the CLI uses the supplied
endpoint and MUST NOT start a Cocod Process. This distinction affects local process discovery only;
local and remote clients use the same HTTP resources and authentication.

## Common representation rules

- Request and response bodies use JSON.
- Timestamps use RFC 3339 UTC strings.
- Identifiers use Coco's existing identities. Cocod MUST NOT persist a public-ID translation table.
  Mint resources use Coco's normalized Mint URL. Quote resources carry Coco's `mintUrl` and
  `quoteId` identity together with `type` to distinguish the Mint and Melt Quote namespaces.
  Operation resources use Coco's existing Operation ID.
- Successful responses contain the documented resource directly, not an `{ output }` envelope.
- Error responses use the common error document below.
- Sensitive request fields MUST be redacted from structured logs.

```json
{
  "error": {
    "code": "session_transition_in_progress",
    "message": "The Coco Session is stopping",
    "retryable": true,
    "details": {
      "state": "stopping"
    }
  }
}
```

`code` is stable interface data. `message` is diagnostic text and clients MUST NOT branch on it.
`details` is optional and its schema depends on `code`.

Cocod defines stable codes for transport, authentication, request validation, and host lifecycle
failures. It maps a Coco failure to a stable Wallet-domain code only when Coco exposes a typed
error for that condition. Untyped Coco failures use `coco_error` with safe diagnostic text. Cocod
MUST NOT parse error messages to infer codes or behavior; a new stable Wallet-domain code requires
a corresponding typed Coco error first.

### Amounts

Amounts MUST be represented losslessly as decimal integer strings. A standalone amount is paired
with its unit:

```json
{
  "value": "1234",
  "unit": "sat"
}
```

Fields that compare several amounts, such as requested amount, input amount, fee reserve, swap fee,
and effective fee, MUST declare their unit unambiguously. A record whose amount fields all share
one unit MAY declare `unit` once and use decimal strings for each amount field.

### Pagination

Paginated collection resources use `offset` and `limit`. A paginated response has this shape:

```json
{
  "items": [],
  "offset": 0,
  "limit": 20
}
```

Endpoints document their default and maximum limit. Pagination does not promise a stable snapshot;
concurrent writes may shift later pages.

### Resource creation and commands

- Successful resource creation returns `201 Created` and the resource document directly. Cocod
  does not use `Location` headers or add lookup routes solely to identify a just-created resource;
  clients derive later requests from the Coco identities in the response document.
- `GET` requests MUST NOT initiate financial transitions. Mint information reads MAY let Coco
  refresh stale Mint metadata as part of resolving the response.
- Quote and Operation reconciliation is an explicit `POST` command named `refresh`.
- Mutation commands accept an optional `Idempotency-Key` according to the concurrency rules in
  this document.
- A command returns the updated resource directly unless its endpoint documents a distinct result.
- A command that is unavailable for the resource's current type or state returns `409 Conflict`
  with the current state in error details when Coco provides it.

## Target resource model

The v1 target surface groups Coco's Quote and Operation interfaces under common HTTP namespaces,
with type-specific subroutes matching the shape Coco currently exposes. Their documents still use
common representation rules:

- A Quote has `type: mint | melt` and a method such as `bolt11`, `bolt12`, or `onchain`.
- An Operation has `type: mint | melt | send | receive` and retains its type-specific state.
- Quote documents preserve Coco's composite Quote Identity. Operation documents use Coco's
  existing Operation identifier. Cocod does not allocate or persist alternate resource identities.
- Responses are stable cocod documents. They MUST NOT serialize Coco classes, raw proofs, proof
  secrets, blinded messages, serialized output data, or repository rows directly.

### Preparation and execution

Creating an Operation means preparing it as far as that Operation type supports. Creation MUST NOT
also execute the Operation.

Preparation is not a dry run. It persists an Operation and may reserve proofs, calculate outputs,
or otherwise reduce spendable balance. The prepared representation exposes safe inspection data
such as requested amount, input amount, fees, whether a swap is required, timestamps, and state. It
MUST omit proof-bearing and recovery data.

The common interaction is:

```text
create Quote when required
        |
        v
create and prepare Operation
        |
        +----> inspect amounts, fees, and state
        |                         |
        |                         +----> cancel when supported
        v
execute explicitly
        |
        v
inspect, refresh, or retrieve result
```

Operation types retain their real Coco states. In particular, preparing a Mint Operation produces
a durable `pending` Operation rather than renaming it to `prepared`. The common interface describes
the transition intent without flattening the underlying state machines.

The CLI MAY retain one-shot human commands by creating and then executing an Operation as two v1
requests. That convenience belongs to the client and MUST NOT remove the prepared Operation from
the network interface.

## Complete endpoint surface

### Process and lifecycle resources

These resources are implemented.

| Method | Path                                 | Purpose                                                     |
| ------ | ------------------------------------ | ----------------------------------------------------------- |
| `GET`  | `/health`                            | Report public Cocod Process liveness.                       |
| `GET`  | `/v1/status`                         | Report Wallet, Wallet Seed Access, and Coco Session status. |
| `POST` | `/v1/admin/wallet/initialize`        | Generate and initialize the Wallet.                         |
| `POST` | `/v1/admin/wallet/recovery-material` | Retrieve Wallet Recovery Material.                          |
| `POST` | `/v1/admin/session/start`            | Start the Coco Session.                                     |
| `POST` | `/v1/admin/session/stop`             | Stop the Coco Session.                                      |
| `POST` | `/v1/admin/process/stop`             | Stop the Cocod Process.                                     |

### Balance resources

This resource is implemented.

| Method | Path           | Purpose                                        |
| ------ | -------------- | ---------------------------------------------- |
| `GET`  | `/v1/balances` | Return balances by Mint and unit through Coco. |

The endpoint calls Coco's `wallet.balances.byMintAndUnit()` with repeatable `mintUrl` and `unit`
query parameters plus optional `trustedOnly`. It returns a flat list and does not add pagination or
additional aggregation:

```json
{
  "items": [
    {
      "mintUrl": "https://mint.example.com",
      "unit": "sat",
      "spendable": "1200",
      "reserved": "300",
      "total": "1500"
    }
  ]
}
```

The response MUST NOT reduce all units to `sat` or omit the distinction between spendable and
reserved proofs.

### Mint resources

These resources are implemented.

| Method | Path                                                      | Purpose                                                           |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/v1/mints`                                               | List Known Mints, optionally limited to trusted Mints.            |
| `POST` | `/v1/mints`                                               | Discover and persist a Known Mint without implicitly trusting it. |
| `GET`  | `/v1/mints/info?mintUrl={mintUrl}`                        | Resolve Mint information through Coco.                            |
| `POST` | `/v1/mints/trust`                                         | Mark the body-supplied `mintUrl` as trusted.                      |
| `POST` | `/v1/mints/untrust`                                       | Remove trust without forgetting the body-supplied `mintUrl`.      |
| `GET`  | `/v1/mints/payment-method-capabilities?mintUrl={mintUrl}` | List Mint and Melt method/unit capabilities.                      |

Mint discovery and Mint trust are separate transitions. Creating a Known Mint MUST NOT authorize
Wallet operations through that Mint until trust is granted explicitly.

Mint information is a `GET` resource even though Coco may perform network I/O and update stale
cached metadata while resolving it. Cocod does not add a forced-refresh command until Coco exposes
one.

Known Mint documents contain `mintUrl`, `name`, `trusted`, `createdAt`, and `updatedAt`. The URL is
normalized through Coco and timestamps are RFC 3339 UTC strings. Registration returns `201` for a
new Known Mint and `200` for an already-known Mint without changing its trust state. New Known Mints
are untrusted; the human-oriented `mints add` CLI follows registration with an explicit trust
command. Registration returns the Known Mint document directly and does not add a separate lookup
resource.

Mint information responses contain the normalized `mintUrl` and an `info` object projected from
Coco's Mint metadata. Payment-method capability responses contain `items` with `operation`, `nut`,
`method`, `unit`, optional decimal-string `minAmount` and `maxAmount`, and optional `options`.

### Quote resources

These resources are proposed.

| Method | Path                                                    | Purpose                                               |
| ------ | ------------------------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/v1/quotes/{type}/pending`                             | List pending Quotes for one type and optional method. |
| `POST` | `/v1/quotes/{type}`                                     | Create a Mint Quote or Melt Quote.                    |
| `GET`  | `/v1/quotes/{type}/{quoteId}?mintUrl={mintUrl}`         | Return canonical local Quote state.                   |
| `POST` | `/v1/quotes/{type}/{quoteId}/refresh?mintUrl={mintUrl}` | Reconcile the Quote with its Mint.                    |

`type` is `mint` or `melt`. These routes map to Coco's separate Mint and Melt Quote interfaces;
cocod does not add a generic cross-type Quote query.

The singular Quote route exists because a Quote has an evolving lifecycle and must be retrieved
after creation. It is not a creation redirect: Quote creation already returns the Quote document,
including the direct Coco identity needed to construct later lookup and refresh requests.

Creating or refreshing a Quote MUST NOT create or execute an Operation. Quote responses expose
remote terms and canonical accounting but omit blinded signatures and other proof-bearing fields.

### Operation resources

These resources are proposed.

| Method | Path                                          | Purpose                                                         |
| ------ | --------------------------------------------- | --------------------------------------------------------------- |
| `POST` | `/v1/operations/{type}`                       | Create and prepare one Operation through its Coco interface.    |
| `GET`  | `/v1/operations/{type}/prepared`              | List prepared Operations when that type exposes the query.      |
| `GET`  | `/v1/operations/{type}/pending`               | List pending Operations when that type exposes the query.       |
| `GET`  | `/v1/operations/{type}/in-flight`             | List in-flight Operations for one type.                         |
| `GET`  | `/v1/operations/{type}/{operationId}`         | Inspect state and safe preparation data.                        |
| `POST` | `/v1/operations/{type}/{operationId}/execute` | Execute or resume the prepared Operation.                       |
| `POST` | `/v1/operations/{type}/{operationId}/cancel`  | Cancel before irreversible execution when supported.            |
| `POST` | `/v1/operations/{type}/{operationId}/refresh` | Reconcile persisted, Wallet, and remote state.                  |
| `POST` | `/v1/operations/{type}/{operationId}/reclaim` | Reclaim a pending Send or Melt when Coco determines it is safe. |
| `GET`  | `/v1/operations/{type}/{operationId}/result`  | Retrieve sensitive or terminal Operation output when exposed.   |

`type` is `mint`, `melt`, `send`, or `receive`. Each list or command exists only for the Operation
types whose public Coco interface exposes that behavior. Cocod does not add a generic cross-type
Operation query or reach into Operation repositories.

Ordinary Operation documents are explicit, type-specific safe projections rather than serialized
Coco objects. They share `id`, `type`, `state`, `mintUrl`, `unit`, `createdAt`, and `updatedAt`, then
add safe type-specific fields such as method, requested amount, input amount, fees, swap need, and
Quote reference. Each implementation slice defines its exact projection from the corresponding
Coco Operation union.

Ordinary Operation documents MUST omit input proofs, proof secrets, raw or encoded input tokens,
blinded messages, serialized output data, Wallet derivation data, and other recovery internals.
Redaction occurs while projecting the Coco result and does not create a second persisted Operation
representation.

`execute`, `cancel`, and `reclaim` are explicit state transitions. Their concurrency and recovery
semantics come from the corresponding Coco Operation interface; cocod does not add another
Operation lock or transition state.

Operation commands await the corresponding Coco call and do not create cocod jobs. Preparation
returns `201 Created` with the safe prepared Operation. Execute, refresh, cancel, and reclaim return
`200 OK` with the latest safe Operation read through Coco; execute also returns a distinct result
when applicable. Client disconnection does not create a separately managed background job or a
cocod cancellation signal. The client reconnects and inspects Coco's Operation state or result.
Only Cocod Process and Coco Session lifecycle transitions use the existing `202 Accepted` model.

Outgoing tokens, payment preimages, outpoints, and other distinct execution results are excluded
from the ordinary Operation document. When Coco returns such a result, a successful `execute`
response contains both the safe `operation` and the type-specific `result`. The response includes
`Cache-Control: no-store`.

`GET /v1/operations/{type}/{operationId}/result` returns the same type-specific result from data
already retained by Coco so a dropped execution response does not strand value-bearing output. It
also includes `Cache-Control: no-store`, returns `409 Conflict` while an applicable result is not
yet available, and returns `404 Not Found` for Operation types that have no distinct result
resource. Cocod MUST NOT maintain a second result store.

`refresh` is the common safe reconciliation command. V1 does not initially expose separate
`check-payment` or `finalize` routes; the adapter maps refresh or execute intent onto the correct
type-specific Coco behavior.

### Outgoing Payment Requests

This resource is proposed.

| Method | Path                            | Purpose                                                   |
| ------ | ------------------------------- | --------------------------------------------------------- |
| `POST` | `/v1/payment-requests/evaluate` | Parse and return structured Payment Request requirements. |

Evaluation is read-like but uses `POST` because the encoded request may be large or sensitive and
is supplied in the body. It does not persist state or move value. The response exposes amount,
unit, transport, allowed Mints, payable Mints, and safe spending-condition requirements.

Paying an evaluated in-band Payment Request uses `POST /v1/operations/send` with a source that
contains the encoded request. The normal prepare, inspect, execute, and result lifecycle then
applies. HTTP and Nostr transport execution return a typed unsupported error until Coco exposes a
durable delivery interface. Cocod does not retain the transient prepared delivery context or add an
incoming Payment Request interface that was not part of its legacy surface.

### History and event resources

These resources are proposed.

| Method | Path                           | Purpose                                         |
| ------ | ------------------------------ | ----------------------------------------------- |
| `GET`  | `/v1/history`                  | Return offset-paginated safe history.           |
| `GET`  | `/v1/history/{historyEntryId}` | Return one safe history entry.                  |
| `GET`  | `/v1/events`                   | Stream safe resource invalidations through SSE. |

History documents MUST omit tokens, proofs, proof secrets, serialized output data, and raw
third-party responses. Events use this envelope:

```json
{
  "type": "quote.updated",
  "timestamp": "2026-08-19T12:00:00.000Z",
  "data": {
    "quoteType": "mint",
    "mintUrl": "https://mint.example.com",
    "method": "bolt11",
    "quoteId": "quote-123"
  }
}
```

The initial stream exposes these event types:

- `history.updated`: a redacted safe history projection.
- `operation.updated`: `{ operationType, operationId, mintUrl }`.
- `quote.updated`: `{ quoteType, mintUrl, method, quoteId }`.
- `mint.updated`: `{ mintUrl }`.
- `balance.updated`: `{ mintUrl }`.

Events are invalidation hints. Consumers fetch the canonical resource after an event when they need
current state. Cocod projects only events Coco already exposes and MUST NOT infer missing Operation
transitions. `balance.updated` may be derived from Coco proof-change events, but cocod forwards only
the Mint URL and never the proofs, secrets, counters, or raw event payload.

Because v1 deliberately has no singular Known Mint lookup route, `mint.updated` causes consumers to
refetch `GET /v1/mints` and select the matching normalized `mintUrl`. Quote and Operation events may
refetch their singular lifecycle resources using the direct Coco identities carried by the event.

V1 does not promise complete transition coverage, event IDs, or replay across a disconnect or
Cocod Process restart. Consumers establish initial state through the resource endpoints before
listening. Complete Operation transition coverage requires a unified post-persistence event in Coco
first.

### Machine-readable description

This resource is proposed.

| Method | Path               | Purpose                                                  |
| ------ | ------------------ | -------------------------------------------------------- |
| `GET`  | `/v1/openapi.json` | Return generated OpenAPI for the implemented v1 surface. |

The document is generated from the runtime request and response schemas. Proposed but unimplemented
resources MUST NOT appear as callable operations in the generated document. Compatibility policy
MUST distinguish additive schema changes from changes that require a new interface version.

## Legacy route replacement map

Legacy command routes remain only until the corresponding v1 resources and CLI calls land in the
same delivery slice.

| Legacy route           | V1 replacement                                                           |
| ---------------------- | ------------------------------------------------------------------------ |
| `GET /balance`         | `GET /v1/balances`                                                       |
| `POST /mints/add`      | `POST /v1/mints`, then `POST /v1/mints/trust`.                           |
| `GET /mints/list`      | `GET /v1/mints`                                                          |
| `POST /mints/info`     | `GET /v1/mints/info?mintUrl={mintUrl}`                                   |
| `POST /receive/bolt11` | Create a Mint Quote, then prepare a Mint Operation.                      |
| `POST /send/bolt11`    | Create a Melt Quote, prepare a Melt Operation, then execute explicitly.  |
| `POST /send/cashu`     | Prepare a Send Operation, then execute explicitly.                       |
| `POST /receive/cashu`  | Prepare a Receive Operation, then execute explicitly.                    |
| `POST /x-cashu/parse`  | Evaluate the Payment Request.                                            |
| `POST /x-cashu/handle` | Evaluate the request, prepare a Send Operation, then execute explicitly. |
| `GET /history`         | `GET /v1/history`                                                        |
| `GET /events`          | `GET /v1/events`                                                         |

The authenticated legacy NPC routes remain available but are outside the current v1 migration
scope.

## Health

### `GET /health`

Reports only whether the HTTP process can answer requests.

```json
{
  "status": "ok",
  "interfaceVersion": "1"
}
```

This endpoint does not prove that a Wallet exists, its seed is available, or a Coco Session is
running.

## Lifecycle status

### `GET /v1/status`

Returns the complete authenticated lifecycle status.

```json
{
  "daemon": {
    "version": "0.1.0",
    "interfaceVersion": "1"
  },
  "wallet": {
    "configuredAt": "2026-08-16T12:00:00.000Z"
  },
  "seedAccess": {
    "state": "locked",
    "requiresPassphrase": true
  },
  "cocoSession": {
    "state": "stopped",
    "startedAt": null,
    "lastFailure": null
  }
}
```

When no Wallet exists, `wallet` and `seedAccess` are `null`.

`lastFailure`, when present, uses the safe fields `code`, `message`, and `occurredAt`. It MUST NOT
contain Wallet-unlocking material, Wallet Seed material, repository connection strings, or raw
third-party responses.

## Initialize a Wallet

### `POST /v1/admin/wallet/initialize`

Creates the single Wallet owned by this cocod process. This command requires `wallet:admin`.

Request:

```json
{
  "passphrase": "optional seed-encryption passphrase"
}
```

Omitting `passphrase` enables unattended Coco Session start. Providing a non-empty passphrase
requires explicit session start after process restart.

Behavior:

- The state directory MUST be mode `0700`; secret-bearing files MUST be mode `0600`.
- Configuration writes MUST be atomic.
- Initialization without a passphrase MUST start a Coco Session without another client request.
- Initialization with a passphrase MUST leave Wallet Seed Access locked and the Coco Session
  stopped.
- Repeating initialization after a Wallet exists returns `wallet_already_configured`.
- The interface does not provide remote Wallet deletion or reset in v1.
- Cocod generates the Wallet Recovery Material and returns its mnemonic as `generatedMnemonic`.
  Sensitive responses MUST NOT be cached or logged.
- Initialization without a passphrase returns `202 Accepted` while the automatic Coco Session
  start is in progress. Initialization with a passphrase returns `201 Created`.

## Retrieve Wallet Recovery Material

### `POST /v1/admin/wallet/recovery-material`

Returns the host-generated Wallet Recovery Material so the Cocod Owner can back it up again. This
command requires `wallet:admin` and is available in every Coco Session state, including `failed`.

For a Wallet configured with a passphrase:

```json
{
  "passphrase": "Wallet Seed encryption passphrase"
}
```

A Wallet without a passphrase uses an empty JSON object.

Behavior:

- A Wallet without a passphrase returns its mnemonic to an authenticated administrative client.
- A Wallet with a passphrase requires and validates that passphrase on every retrieval. The Client
  Credential or a running Coco Session MUST NOT bypass this requirement.
- Retrieval decrypts only for the response. It MUST NOT start or stop a Coco Session, persist the
  passphrase, or change the reported Wallet Seed Access or Coco Session state.
- A successful response is `{ "mnemonic": "..." }` and includes `Cache-Control: no-store`.
- Request bodies and response bodies MUST NOT be logged. A safe audit log MAY record that retrieval
  occurred without recording Wallet Recovery Material, the passphrase, or the Client Credential.
- Missing or invalid passphrases use the same safe error semantics as Coco Session start.
- The operation is repeatable and does not require an `Idempotency-Key`.

## Start a Coco Session

### `POST /v1/admin/session/start`

Makes Wallet Seed Access available when necessary, constructs the Coco Session, and runs Coco
startup recovery. This command requires `wallet:admin`.

For a Wallet configured with a passphrase:

```json
{
  "passphrase": "Wallet Seed encryption passphrase"
}
```

A Wallet without a passphrase uses an empty JSON object.

Behavior:

- When a passphrase is configured, cocod validates it and acquires Wallet Seed Access before
  accepting the transition. Otherwise no unlocking material is required.
- A valid request transitions the session to `starting` and returns `202 Accepted` with status.
- Clients observe completion through `GET /v1/status` or the future event stream.
- Calling start while the session is `running` is idempotent and returns `200 OK` with status.
- Calling start while the session is `starting` returns `202 Accepted` with status.
- Calling start while the session is `stopping` returns `session_transition_in_progress`.
- Calling start while the session is `failed` returns `session_restart_required`.
- A failed Wallet Seed Access attempt returns `wallet_unlock_failed` without revealing why it
  failed.
- Startup failure records `lastFailure`. After confirmed cleanup it returns the session to
  `stopped`; Wallet Seed Access is locked when a passphrase is configured and remains available
  otherwise. Unconfirmed cleanup transitions the session to `failed`.

Request-supplied Wallet-unlocking material MUST NOT be retained after Wallet Seed Access has been
acquired.

## Stop a Coco Session

### `POST /v1/admin/session/stop`

Stops Wallet-dependent work, disposes the Coco Session, and removes seed bytes retained by that
session from reachable application state. This command requires `wallet:admin`.

Behavior:

- A running session transitions to `stopping` and returns `202 Accepted` with status.
- Calling stop while the session is `stopped` is idempotent and returns `200 OK` with status.
- Calling stop while the session is `stopping` returns `202 Accepted` with status.
- Calling stop while the session is `starting` requests cancellation; cocod MUST finish cleaning up
  before reporting `stopped`.
- New Wallet-dependent requests MUST be rejected once stopping begins.
- Successful disposal results in a stopped session. Wallet Seed Access becomes locked when a
  passphrase is configured and remains available otherwise.
- Explicit stop remains in effect until another session-start request or process restart. Cocod
  MUST NOT immediately undo an explicit stop by starting another session.
- Disposal failures MUST be logged safely, reflected in `lastFailure`, and transition the session
  to `failed`; they MUST NOT leave the interface reporting the session as running.
- Graceful shutdown has a configurable deadline that defaults to 30 seconds. If cleanup cannot be
  confirmed by the deadline, the Coco Session transitions to `failed`.

## Process shutdown

### `POST /v1/admin/process/stop`

Requests graceful termination of the Cocod Process. This command requires `wallet:admin` and
returns `202 Accepted` before closing the listener.

After accepting the request, cocod stops accepting new work, closes its listener, and attempts to
stop the Coco Session within the configurable 30-second deadline. Disconnecting the initiating
client does not cancel an accepted shutdown. Successful cleanup exits zero; cleanup that cannot be
confirmed records and logs a safe failure and exits non-zero.

The endpoint requests termination of the current process; it does not promise that the deployment
remains stopped. A process supervisor or container runtime may start another Cocod Process. Local
and remote `cocod stop` commands call this same endpoint.

## Wallet-dependent requests

Wallet-dependent routes introduced by later revisions MUST behave consistently with lifecycle
state:

- `running`: process the request.
- `starting` or `stopping`: return `session_transition_in_progress`, normally with `503` and a
  `Retry-After` header.
- `failed`: return `session_restart_required` with `503`.
- `stopped` with locked Wallet Seed Access: return `wallet_locked` with `423 Locked`.
- `stopped` with available Wallet Seed Access: return `session_stopped` with `503`.
- no Wallet: return `wallet_not_configured` with `409 Conflict`.

Read-only process endpoints such as `/health` and authenticated `/v1/status` remain available in
every state.

## Concurrency and retries

- Mutation requests MAY include an `Idempotency-Key` header.
- Repeating the same key and request returns the original result.
- Reusing a key with a different request returns `idempotency_key_conflict`.
- All cocod idempotency records live only in memory for the lifetime of one Cocod Process. Cocod
  does not add a durable idempotency ledger beside Coco's repositories. After restart, clients
  reconcile through lifecycle status and the underlying Coco resources; cocod does not promise to
  replay the original response for a pre-restart key.
- Cocod serializes lifecycle transitions.
- Concurrent callers observe the same transition; cocod MUST NOT construct two Coco Sessions.
- Disconnecting the initiating client does not cancel an accepted transition.

## Required interaction scenarios

Implementations and contract tests MUST cover these scenarios.

### First start

1. Start cocod; `/health` reports `ok`.
2. Authenticate and read `/v1/status`; no Wallet is configured.
3. Initialize a Wallet with or without a passphrase.
4. Store the generated Wallet Recovery Material outside cocod. If delivery is interrupted, retrieve
   it through the authenticated recovery-material endpoint.
5. Without a passphrase, poll status while cocod starts the Coco Session automatically.
6. With a passphrase, explicitly start the Coco Session and then poll status.

### Unattended process restart

1. Configure a Wallet without a passphrase and stop the cocod process.
2. Start cocod again.
3. Cocod loads the Wallet with available Wallet Seed Access and starts a Coco Session.
4. Clients poll status until the session is running; no unlocking request is required.

### Passphrase-protected process restart

1. Configure a Wallet with a passphrase and stop the cocod process.
2. Cocod disposes the Coco Session before exit.
3. Start cocod again.
4. The Wallet remains configured, Wallet Seed Access is locked, and the session is stopped.
5. A client explicitly starts a new Coco Session with the passphrase.

### Failed session start

1. Request a session start, supplying the passphrase when one is configured.
2. Coco startup or Operation Recovery fails.
3. Cocod attempts to dispose partial resources.
4. Confirmed cleanup reports `stopped` and a safe `lastFailure`; a later start request can retry.
5. Unconfirmed cleanup reports `failed`; the process must restart before another start request.

### Concurrent start

1. Two authorized clients request start concurrently.
2. Cocod accepts one transition.
3. Both clients observe the same starting or running session.
4. Only one Coco Session is constructed.

### Stop during startup

1. A start request is accepted.
2. Another authorized client requests stop while startup is in progress.
3. Cocod cancels or finishes startup, disposes all acquired session resources, restores Wallet
   Seed Access according to the Wallet configuration, and reports stopped.

## Wallet Import

Wallet Import is not part of the network interface in v1. A later host-local workflow may
initialize cocod from existing Wallet Recovery Material. After Wallet Import, Coco Restore remains
a separate action that reconstructs proofs from mints; importing the mnemonic does not itself
restore proofs.

## Delivery order

The accepted target surface lands as focused vertical slices. Each slice specifies request and
response schemas, implements runtime routes, migrates the CLI, removes the superseded legacy route,
and updates the generated interface description before it is complete.

When a slice depends on a missing Coco capability, its upstream Coco interface and implementation
land before the cocod adapter. The slice does not add cocod-local substitute behavior.

1. Common identifiers, lossless amounts, offset pagination, errors, and schema infrastructure.
2. Balance snapshots.
3. Known Mint, trust, metadata, and capability resources.
4. Quote resources.
5. Operation resources, beginning with Send and Receive preparation/execution semantics, then Mint
   and Melt Quote-backed workflows.
6. Outgoing Payment Request evaluation and in-band Send integration.
7. History and safe live events.
8. Generated OpenAPI and client compatibility enforcement.
