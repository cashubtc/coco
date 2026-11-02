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

- `mints add <url>` - Add mint URL
- `mints list` - List configured mints
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

- The v1 JSON resources return typed documents directly. Their errors use
  `{ "error": { "code": string, "message": string, "retryable": boolean, "details"?: object } }`.
- The remaining operational legacy routes retain `{ "output": <value> }` success and
  `{ "error": "message" }` error envelopes.

### Endpoint list

- `GET /health` (public)
- `GET /v1/status`
- `GET /v1/openapi.json` (authenticated OpenAPI 3.1 description)
- `POST /v1/admin/wallet/initialize`
- `POST /v1/admin/wallet/recovery-material`
- `POST /v1/admin/session/start`
- `POST /v1/admin/session/stop`
- `POST /v1/admin/process/stop`
- `GET /v1/balances?mintUrl=…&unit=…&trustedOnly=true` (`wallet:read`; repeatable Mint/unit filters)
- `GET /v1/mints?trustedOnly=true` (`wallet:read`)
- `POST /v1/mints` `{ mintUrl, trusted? }` (`wallet:admin`; idempotent registration, `200`)
- `POST /v1/mints/trust` and `/v1/mints/untrust` `{ mintUrl }` (`wallet:admin`; `404` when unknown)
- `GET /v1/mints/info?mintUrl=…` (`wallet:read`; may refresh stale metadata)
- `GET /v1/mints/payment-method-capabilities?mintUrl=…` (`wallet:read`)
- `GET /v1/history?offset=0&limit=20` (`wallet:read`; newest first, maximum limit 100)
- `GET /v1/events` (`wallet:read`; safe SSE invalidations for a running Coco Session, no-store)
- `GET /v1/history/{historyEntryId}` (`wallet:read`; URL-encoded Operation or legacy history ID)
- `GET /balance`
- `POST /receive/cashu`
- `POST /receive/bolt11`
- `POST /send/cashu`
- `POST /send/bolt11`
- `POST /x-cashu/parse`
- `POST /x-cashu/handle`
- `POST /mints/add`
- `GET /mints/list`
- `POST /mints/info`
- `GET /history`
- `GET /events` (SSE stream)
- `GET /npc/address`
- `POST /npc/username`

### V1 events

`GET /v1/events` returns `text/event-stream`. Each `data` line contains `{ type, timestamp, data }`
for `history.updated`, `operation.updated`, `quote.updated`, `mint.updated`, or `balance.updated`.
These safe projections omit bearer tokens, proofs, preimages, and raw metadata. Fetch initial state
and refetch after invalidations; there are no event IDs or replay.

Five-second keep-alives recheck the original Client Credential and `wallet:read`. The stream closes
on failed authorization, session end/replacement, client disconnect, or application queue overflow
(256 chunks). Reconnect and refetch after disconnects. See [event semantics](network-interface-v1.md#events)
for payloads and cleanup behavior. Legacy `/events` and the current CLI remain unchanged.

### Send, Receive, and outgoing Payment Requests

Capabilities: `read` is `wallet:read`, `admin` is `wallet:admin`; `idem` accepts an optional
`Idempotency-Key`. Collection reads accept `offset` and `limit`.

- Send: `POST /v1/operations/send` `{ amount, unit?, mintUrl?, forceSwap? }` or
  `{ source: { type: "payment-request", request }, mintUrl?, amount?, unit? }` (admin, idem, `201`;
  `unit` requires `amount`); `GET /v1/operations/send/prepared`, `/in-flight`, `/{id}` (read);
  `GET /v1/operations/send/{id}/result` (admin, no-store; the token);
  `POST /v1/operations/send/{id}/execute` (admin, idem, no-store; `{ operation, result: { token } }`),
  `/cancel`, `/refresh`, `/reclaim` (admin, idem).
- Receive: `POST /v1/operations/receive` `{ token }` (admin, idem, `201`);
  `GET /v1/operations/receive/prepared`, `/in-flight`, `/{id}` (read);
  `POST /v1/operations/receive/{id}/execute`, `/cancel`, `/refresh` (admin, idem).
- `POST /v1/payment-requests/evaluate` `{ request }` (read) resolves an outgoing request's amount,
  unit, transport, allowed/payable Mints, and spending condition without preparing or paying it.

Creation prepares and persists an Operation without executing it. Ordinary Operation documents omit
proofs, secrets, output data, and tokens. Only Send execute/result responses return bearer tokens;
those responses, including errors, use `Cache-Control: no-store`.

Amounts are decimal strings. Payment Request payments support in-band transport only. Without an
explicit Mint, preparation chooses the configured Mint when payable for the requested or supplied
amount, otherwise the first payable Mint. See [transfer semantics](network-interface-v1.md#send-receive-and-outgoing-payment-requests)
for fees, errors, and uncertain outcomes. Existing CLI and legacy endpoints remain available.

For the remaining operational legacy request/response details, see `docs/daemon-api.json`. The
generated OpenAPI description of the implemented v1 routes is `docs/openapi-v1.json`, also
served at authenticated `GET /v1/openapi.json`. It remains available without a running Coco Session.

The v1 balances, Known Mint, and history routes require a running Coco Session. Mint commands
accept an optional `Idempotency-Key`. New Known Mints are untrusted by default; re-registration
without `trusted` preserves an existing trust decision. A committed trust change succeeds even
when a subsequent metadata refresh fails.

Balances report spendable, reserved, and total amounts as decimal strings for each Mint and unit.
History returns safe projections without tokens, payment requests, metadata, or error text; list
responses use `{ items, offset, limit }`. See the
[Wallet resource contract](network-interface-v1.md#wallet-information-and-known-mints) for details.

## V1 Quote-backed Operations

All routes below require a running Coco Session. `read` means `wallet:read`, `admin` means
`wallet:admin`, and `idem` means an optional `Idempotency-Key` header. Every create request
for a Quote includes the `method` discriminator. Commands without inputs accept no body or `{}`.

Quotes (`{type}` is `mint` or `melt`; a Quote is addressed by `quoteId` and `mintUrl`):

- `POST /v1/quotes/mint` - admin, idem, `201`; `bolt11` `{ amount, unit?, mintUrl?, locked? }`,
  `bolt12` `{ amount?, unit?, mintUrl?, description? }`, or `onchain` `{ unit?, mintUrl? }`
- `POST /v1/quotes/melt` - admin, idem, `201`; `bolt11` `{ invoice, amountSats? }`, `bolt12`
  `{ offer, amountSats? }`, or `onchain` `{ address, amountSats }`, each with `unit?` (the funding
  unit, default `sat`) and `mintUrl?`. `amountSats` is always denominated in satoshis.
- `GET /v1/quotes/{type}/pending?method=&offset=&limit=` - read
- `GET /v1/quotes/{type}/{quoteId}?mintUrl=` - read
- `POST /v1/quotes/{type}/{quoteId}/refresh?mintUrl=` - admin, idem

Operations (`{id}` is Coco's Operation ID; collections accept `offset` and `limit`):

- Mint: `POST /v1/operations/mint` `{ mintUrl, quoteId, amount }` (admin, idem, `201`, yields a
  `pending` Operation); `GET /v1/operations/mint/pending`, `/in-flight`, `/{id}` (read);
  `POST /v1/operations/mint/{id}/execute`, `/refresh` (admin, idem)
- Melt: `POST /v1/operations/melt` `{ mintUrl, quoteId, feeIndex? }` (admin, idem, `201`;
  `feeIndex` is required for on-chain Quotes and rejected otherwise);
  `GET /v1/operations/melt/prepared`, `/in-flight`, `/{id}` (read); `GET /v1/operations/melt/{id}/result`
  (admin, no-store; the preimage or outpoint); `POST /v1/operations/melt/{id}/execute` (admin, idem,
  no-store), `/cancel`, `/refresh`, `/reclaim` (admin, idem)

Ordinary documents omit proofs, secrets, output data, raw Mint error text, and payment preimages.
Melt execute returns `{ operation, result? }`; result reads return the preimage or outpoint only
when the finalized Operation has one, otherwise `409 operation_result_not_available`.
The execute and result endpoints return `Cache-Control: no-store` even on errors.
