# API and Command Reference

This document contains the detailed reference moved out of `README.md`.

## CLI commands

All commands are available under `cocod`.

Use the implicit `http://127.0.0.1:62626` endpoint for local auto-start. The global
`--url <origin>` option and `COCOD_URL` select an existing endpoint and disable auto-start.

### Wallet

- `status` - Show Cocod Process, Wallet Seed Access, and Coco Session status
- `wallet initialize` - Create a Wallet and display its host-generated Wallet Recovery Material
  - `--passphrase <str>` protect Wallet Seed Access and require explicit Coco Session start
- `wallet recovery-material` - Retrieve Wallet Recovery Material again after initialization
  - `--passphrase <str>` required for protected Wallet Seed Access
- `session start` - Start the Coco Session
  - `--passphrase <str>` supply the passphrase for protected Wallet Seed Access
- `session stop` - Stop the Coco Session without stopping the Cocod Process
- `balance` - Get wallet balances
- `history` - List history entries
  - `--offset <number>` default `0`
  - `--limit <number>` default `20`, max `100`
  - `--watch` stream real-time updates after initial fetch

### Receive

- `receive cashu <token>` - Receive a Cashu token
- `receive bolt11 <amount>` - Create a Lightning invoice
  - `--mint-url <url>` override default mint for this request

### Send

- `send cashu <amount>` - Create a Cashu token to send
  - `--mint-url <url>` override default mint
- `send bolt11 <invoice>` - Pay a Lightning invoice
  - `--mint-url <url>` override default mint

### Mints

- `mints add <url>` - Register and explicitly trust a Known Mint
- `mints list` - List trusted Known Mints
- `mints info <url>` - Fetch mint metadata

### NPC

- `npc address` - Get your NPC Lightning address
- `npc username <name>` - Begin username purchase flow
  - `--confirm` confirm payment and complete purchase

### X-Cashu / NUT-24

- `x-cashu parse <request>` - Parse an encoded payment request
- `x-cashu handle <request>` - Settle request and return `X-Cashu: cashuB...` header value

Both `creqA` and `creqB` encodings are accepted. NUT-10 spending conditions are enforced
by Coco: P2PK-locked requests are paid with locked outputs; unsupported or malformed
conditions return a 400 before any proofs move.

### Daemon control

- `health` - Check Cocod Process reachability
- `daemon` - Start daemon in foreground
- `stop` - Stop the Cocod Process (distinct from `session stop`)
- `logs` - Read this host's daemon log (host-local)
- `credential rotate` - Rotate this host's administrative Client Credential (host-local)

## Daemon HTTP endpoints

The CLI talks to cocod over its single authenticated HTTP listener on TCP. The listener defaults to
`127.0.0.1:62626`; set `COCOD_LISTEN_HOST` and `COCOD_LISTEN_PORT` explicitly to override it. The
daemon validates both settings and does not inherit a generic `PORT` variable.

Listener overrides apply to an explicitly started `cocod daemon`. Auto-start always uses the local
default; connect to a custom listener with `--url` or `COCOD_URL`, which never starts a process.

`GET /health` is public. Every `/v1/*` request and every remaining legacy route requires
`Authorization: Bearer <credential>`. The local client reads the credential from
`~/.cocod/credentials/current/client`. Remote TLS belongs at a trusted proxy such as Caddy; cocod
still authenticates the credential itself, ignores forwarded identity headers, and does not enable
browser CORS.

### Response shapes

- The v1 resources return typed documents directly. Their errors use
  `{ "error": { "code": string, "message": string, "retryable": boolean, "details"?: object } }`.
- The remaining operational legacy routes retain `{ "output": <value> }` success and
  `{ "error": "message" }` error envelopes.

### HTTP header policy

- `Authorization: Bearer <credential>` is the only required application-level request header.
- Mutation requests may use `Idempotency-Key` for process-local retry deduplication. It is optional
  and does not survive a Cocod Process restart.
- The CLI sends `Content-Type: application/json` for JSON bodies. Cocod does not use `Accept` for
  representation negotiation.
- Resource creation returns the resource document directly. Cocod does not use `Location` headers
  or add lookup routes solely for resource discovery.
- Responses use ordinary protocol headers where applicable: `Content-Type`, `Cache-Control:
no-store`, `Retry-After`, `WWW-Authenticate`, `X-Request-ID`, and `Allow`. These headers do not
  carry Wallet state or resource identity.
- Cocod does not use cookies, CORS, forwarded identity headers, `ETag`, or `Last-Event-ID`.

### Endpoint list

- `GET /health` (public)
- `GET /v1/status`
- `POST /v1/admin/wallet/initialize`
- `POST /v1/admin/wallet/recovery-material`
- `POST /v1/admin/session/start`
- `POST /v1/admin/session/stop`
- `POST /v1/admin/process/stop`
- `GET /v1/balances`
- `GET /v1/mints`
- `POST /v1/mints`
- `GET /v1/mints/info?mintUrl={mintUrl}`
- `POST /v1/mints/trust`
- `POST /v1/mints/untrust`
- `GET /v1/mints/payment-method-capabilities?mintUrl={mintUrl}`
- `POST /v1/quotes/mint`
- `GET /v1/quotes/mint/pending?method={method}&offset={offset}&limit={limit}`
- `GET /v1/quotes/mint/{quoteId}?mintUrl={mintUrl}`
- `POST /v1/quotes/mint/{quoteId}/refresh?mintUrl={mintUrl}`
- `POST /v1/quotes/melt`
- `GET /v1/quotes/melt/pending?method={method}&offset={offset}&limit={limit}`
- `GET /v1/quotes/melt/{quoteId}?mintUrl={mintUrl}`
- `POST /v1/quotes/melt/{quoteId}/refresh?mintUrl={mintUrl}`
- `POST /v1/operations/send`
- `GET /v1/operations/send/prepared?offset={offset}&limit={limit}`
- `GET /v1/operations/send/in-flight?offset={offset}&limit={limit}`
- `GET /v1/operations/send/{operationId}`
- `POST /v1/operations/send/{operationId}/execute`
- `GET /v1/operations/send/{operationId}/result`
- `POST /v1/operations/send/{operationId}/cancel`
- `POST /v1/operations/send/{operationId}/refresh`
- `POST /v1/operations/send/{operationId}/reclaim`
- `POST /receive/cashu`
- `POST /receive/bolt11`
- `POST /send/bolt11`
- `POST /x-cashu/parse`
- `POST /x-cashu/handle`
- `GET /history`
- `GET /events` (SSE stream)
- `GET /npc/address`
- `POST /npc/username`

The list above is the currently callable HTTP interface. See the
[accepted network interface v1](network-interface-v1.md) for the complete target resource surface
and legacy replacement map; resources marked as proposed there are not callable yet.

The [implemented v1 contract](lifecycle-api-v1.json) is generated from runtime schemas.
The [remaining legacy operational contract](daemon-api.json) describes the unversioned routes that
have not yet migrated to v1.

### Quote resources

Quote creation and the `/refresh` reconciliation commands use Coco's public Quote interface and
never prepare or execute an Operation. Creation returns `201 Created` with the Quote document
directly and no `Location` header. Lookup and reconciliation identify a Quote by its type-specific
namespace, normalized `mintUrl`, and Coco `quoteId`. Reconciliation commands have no request body.

Mint Quote creation bodies use one of these method-specific shapes:

- `bolt11`: `{ mintUrl, method, amount, unit, locked? }`
- `bolt12`: `{ mintUrl, method, unit, amount?, description? }`
- `onchain`: `{ mintUrl, method, unit }`

Melt Quote creation bodies use one of these shapes:

- `bolt11`: `{ mintUrl, method, invoice, amount?, unit? }`
- `bolt12`: `{ mintUrl, method, offer, amount?, unit? }`
- `onchain`: `{ mintUrl, method, address, amount, unit? }`

Every amount is a lossless decimal string. Ordinary Quote documents contain explicit safe fields
only. They omit public-key derivation data, payment preimages, outpoints, blinded signatures,
blinded change, and unrecognized Coco model fields.

Pending lists accept optional `method`, `offset`, and `limit` query parameters. Offset defaults to
`0`; limit defaults to `20` and cannot exceed `100`. Cocod deterministically sorts the canonical
pending set returned by Coco and selects the requested page in memory, so these requests currently
load all pending Quotes before slicing.

### Send Operation resources

`POST /v1/operations/send` prepares a Cashu Send Operation without executing it. Its body is
`{ amount, unit, mintUrl?, forceSwap? }`, where `amount` is a lossless decimal string. When
`mintUrl` is omitted, cocod uses the Wallet's configured default Mint. Preparation returns
`201 Created` with the safe Operation directly and no `Location` header.

The safe Send Operation document contains `id`, `type`, `state`, normalized `mintUrl`, `unit`,
`method`, `requestedAmount`, `createdAt`, and `updatedAt`. Every state after `init` also contains
`inputAmount`, `fee`, and `needsSwap`. It never contains input proof secrets, method data,
serialized output data, proofs, raw tokens, or other recovery internals.

Only the collections supported by Coco's public Send interface are exposed: `/prepared` and
`/in-flight`. The latter retains Coco's real in-flight states (`executing`, `pending`, and
`rolling_back`) rather than renaming them. Both collections use `offset` and `limit`, defaulting to
`0` and `20` with a maximum limit of `100`. Cocod sorts the complete canonical Coco set by newest
creation time and then Operation ID before selecting the page.

Execute, cancel, refresh, and reclaim are explicit `POST` commands with no request body. Commands
await Coco rather than creating cocod jobs. Cancel, refresh, and reclaim then read and return the
canonical safe Operation through Coco. Unsupported state transitions return
`invalid_operation_state` with the current and expected states when Coco supplies its typed
lifecycle error.

Successful execute returns `{ operation, result: { token } }`. The authenticated result resource
returns the same `{ token }` from the token already retained in Coco-owned Operation state; cocod
does not persist a second result. Execute and result responses use `Cache-Control: no-store`. A
result that is not yet available returns `409 Conflict` with `operation_result_not_available` and
the current state.

The human `send cashu` command preserves its one-shot behavior by preparing and then executing
through these v1 resources and printing the encoded token.
