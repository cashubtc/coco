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
- `balance` - Print spendable, reserved, and total balances by Mint and unit as JSON
- `history` - Print history entries as JSON
  - `--offset <number>` default `0`
  - `--limit <number>` default `20`, max `100`
  - `--watch` print each new or changed history entry as one JSON line, reconnecting after a
    disconnect, until a non-retryable failure such as a stopped Coco Session

### Receive

- `receive cashu <token>` - Receive a Cashu token
- `receive bolt11 <amount>` - Create a Lightning invoice; Coco redeems it once paid
  - `--mint-url <url>` override default mint for this request

### Send

- `send cashu <amount>` - Create a Cashu token to send
  - `--mint-url <url>` override default mint
- `send bolt11 <invoice>` - Pay a Lightning invoice and report whether it settled
  - `--mint-url <url>` override default mint

### Mints

- `mints add <url>` - Register and trust a Mint
- `mints list` - List trusted Mints
- `mints info <url>` - Print Mint information as JSON

### Operations

- `operations show <mint|melt|send|receive> <id>` - Print a Wallet Operation as JSON
- `operations cancel <melt|send|receive> <id>` - Cancel a prepared Operation and release its
  reservations

One-shot send, receive, and payment commands prepare an Operation and then execute it. When
execution fails, the error reads the Operation and reports its state, naming the commands that can
inspect it and, while it is still prepared, cancel it.

### NPC

- `npc address` - Get your NPC Lightning address
- `npc username <name>` - Begin username purchase flow
  - `--confirm` confirm payment and complete purchase

### X-Cashu / NUT-24

- `x-cashu parse <request>` - Parse an encoded payment request
- `x-cashu handle <request>` - Settle request and return `X-Cashu: cashuB...` header value

Both `creqA` and `creqB` encodings are accepted. NUT-10 spending conditions are enforced
by Coco: P2PK-locked requests are paid with locked outputs; unsupported or malformed
conditions are rejected before any proofs move. `x-cashu handle` pays in-band requests only, from
the configured Mint when it can pay and otherwise from the first payable Mint.

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

`GET /health` is public. Every `/v1/*` request and both NPC routes require
`Authorization: Bearer <credential>`. The local client reads the credential from
`~/.cocod/credentials/current/client`. Remote TLS belongs at a trusted proxy such as Caddy; cocod
still authenticates the credential itself, ignores forwarded identity headers, and does not enable
browser CORS.

The [network interface](network-interface-v1.md) specifies representation, errors, and lifecycle
rules. `GET /v1/openapi.json` and the committed [OpenAPI document](openapi-v1.json) give exact
request, response, parameter, capability, and status schemas. Regenerate the committed copy with
`bun run generate:interface`.

### Response shapes

- v1 resources return typed documents directly. Errors use
  `{ "error": { "code": string, "message": string, "retryable": boolean, "details"?: object } }`.
- The NPC routes keep `{ "output": <value> }` success and `{ "error": "message" }` error envelopes;
  see [daemon-api.json](daemon-api.json).

### Endpoint list

Capabilities: `read` is `wallet:read`, `admin` is `wallet:admin`. Commands marked `idem` accept an
optional `Idempotency-Key`; `no-store` responses are never cached.

Lifecycle and interface:

- `GET /health` - public
- `GET /v1/status` - read
- `POST /v1/admin/wallet/initialize` - admin, idem, no-store
- `POST /v1/admin/wallet/recovery-material` - admin, no-store
- `POST /v1/admin/session/start` - admin, idem
- `POST /v1/admin/session/stop` - admin, idem
- `POST /v1/admin/process/stop` - admin, idem
- `GET /v1/openapi.json` - read

Balances and Known Mints:

- `GET /v1/balances?mintUrl=…&unit=…&trustedOnly=` - read; repeatable `mintUrl` and `unit` filters
- `GET /v1/mints?trustedOnly=` - read
- `POST /v1/mints` `{ mintUrl, trusted? }` - admin, idem; idempotent registration, `200`
- `POST /v1/mints/trust` and `/v1/mints/untrust` `{ mintUrl }` - admin, idem; `404` when unknown
- `GET /v1/mints/info?mintUrl=` - read; may refresh stale metadata
- `GET /v1/mints/payment-method-capabilities?mintUrl=` - read

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
- Send: `POST /v1/operations/send` `{ amount, unit?, mintUrl?, forceSwap? }` or
  `{ source: { type: "payment-request", request }, mintUrl?, amount?, unit? }` (admin, idem, `201`;
  `unit` requires `amount`); `GET /v1/operations/send/prepared`, `/in-flight`, `/{id}` (read);
  `GET /v1/operations/send/{id}/result` (admin, no-store; the token);
  `POST /v1/operations/send/{id}/execute` (admin, idem, no-store; `{ operation, result: { token } }`),
  `/cancel`, `/refresh`, `/reclaim` (admin, idem)
- Receive: `POST /v1/operations/receive` `{ token }` (admin, idem, `201`);
  `GET /v1/operations/receive/prepared`, `/in-flight`, `/{id}` (read);
  `POST /v1/operations/receive/{id}/execute`, `/cancel`, `/refresh` (admin, idem)

Payment Requests, history, and events:

- `POST /v1/payment-requests/evaluate` `{ request }` - read
- `GET /v1/history?offset=&limit=` - read; newest first
- `GET /v1/history/{historyEntryId}` - read; `send:{operationId}` or `legacy:{legacyHistoryId}`
- `GET /v1/events` - read, no-store; server-sent invalidations

Documents omit proofs, secrets, output data, Mint error text, and history tokens, requests, and
metadata. Only the Send execute and result responses contain an encoded token.

NPC extension:

- `GET /npc/address` - read
- `POST /npc/username` - admin
