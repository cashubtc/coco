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

- The v1 lifecycle resources return typed documents directly. Their errors use
  `{ "error": { "code": string, "message": string, "retryable": boolean, "details"?: object } }`.
- The remaining operational legacy routes retain `{ "output": <value> }` success and
  `{ "error": "message" }` error envelopes.

### Endpoint list

- `GET /health` (public)
- `GET /v1/status`
- `POST /v1/admin/wallet/initialize`
- `POST /v1/admin/wallet/recovery-material`
- `POST /v1/admin/session/start`
- `POST /v1/admin/session/stop`
- `POST /v1/admin/process/stop`
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

The list above is the currently callable HTTP interface. See the
[accepted network interface v1](network-interface-v1.md) for the complete target resource surface
and legacy replacement map; resources marked as proposed there are not callable yet.

The [implemented v1 lifecycle contract](lifecycle-api-v1.json) is generated from runtime schemas.
The [remaining legacy operational contract](daemon-api.json) describes the unversioned routes that
have not yet migrated to v1.
