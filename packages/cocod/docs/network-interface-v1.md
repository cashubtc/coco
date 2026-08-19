# Cocod Network Interface v1

Status: accepted and implemented for the authenticated TCP transport, legacy compatibility,
Wallet and Coco Session lifecycle, Wallet Recovery Material, and Cocod Process shutdown described
here. The later balance, mint, quote, operation, history, and event resources remain proposed.

This document specifies cocod's machine-oriented network interface. The implemented first revision
covers the Wallet and Coco Session lifecycle; later revisions will specify balances, mints, quotes,
operations, history, and events.

Normative requirements use **MUST**, **MUST NOT**, **SHOULD**, and **MAY**.

## Goals

- Give local and remote clients one authenticated HTTP interface over TCP.
- Preserve Coco's durable quote and operation lifecycles instead of reducing them to CLI strings.
- Make retries, concurrent callers, and process restarts predictable.
- Keep Wallet Seed material and proof-bearing Coco models out of ordinary responses and logs.
- Generate a machine-readable interface description from the schemas used at runtime.

## Non-goals

- Mirroring every method on Coco's `Manager` class.
- Supporting multiple Wallets in one cocod process.
- Defining payment, quote, or operation resources in this first revision.
- Identifying or revoking individual Cocod Clients in the first interface version.
- Importing a Wallet from existing Wallet Recovery Material through the network interface.
- Providing native TLS termination.
- Supporting browser clients or defining a CORS policy.
- Preserving the current `{ output }` and `{ error }` response shapes in `/v1` resources.
- Providing durable event replay in the first interface version.

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

Authentication proves which client is calling cocod. It does not by itself grant Wallet Seed
Access.

Browser clients are outside v1 scope. Cocod does not emit permissive CORS headers and clients MUST
NOT expose the shared administrative credential to browser storage or browser application code.

## Legacy command compatibility

The existing unversioned command routes move from the Unix socket to the same TCP listener as
`/v1`. They retain their current request and response shapes temporarily so the CLI's balance,
send, receive, mint, history, NPC, and X-Cashu commands remain usable while their v1 resources are
specified.

Every unversioned route except the minimal health check requires the same administrative Client
Credential. Cocod does not run a Unix listener or a second compatibility transport. Later interface
revisions replace these routes incrementally and remove their CLI-oriented response envelopes.

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
- Identifiers are opaque strings.
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

Proposed request:

```json
{
  "passphrase": "optional seed-encryption passphrase"
}
```

Omitting `passphrase` enables unattended Coco Session start. Providing a non-empty passphrase
requires explicit session start after process restart.

Proposed behavior:

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

Proposed behavior:

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

Proposed behavior:

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

Proposed behavior:

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

- Lifecycle mutation requests SHOULD include an `Idempotency-Key` header.
- Repeating the same key and request returns the original result.
- Reusing a key with a different request returns `idempotency_key_conflict`.
- Idempotency records live only for the lifetime of one Cocod Process. After a restart, clients
  reconcile lifecycle state through `GET /v1/status`; cocod does not promise to replay the original
  response for a pre-restart key.
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

## Next specification slices

After the lifecycle is accepted, extend this document in this order:

1. Common identifiers, amounts, timestamps, pagination, errors, and idempotency.
2. Balance snapshots and mint trust/capability resources.
3. Mint and Melt Quotes as durable resources.
4. Mint, Melt, Send, and Receive Operations with explicit lifecycle commands.
5. Payment requests, history, and safe live events.
6. Generated OpenAPI and client compatibility policy.
