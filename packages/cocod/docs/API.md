# API and Command Reference

This document contains the detailed reference moved out of `README.md`.

## CLI commands

All commands are available under `cocod`.

### Wallet

- `status` - Check daemon and wallet status
- `init [mnemonic]` - Initialize wallet; generates mnemonic if omitted
  - `--passphrase <str>` encrypt wallet at creation time
  - `--mint-url <url>` set default mint URL
- `unlock <passphrase>` - Unlock encrypted wallet
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

### Daemon control

- `ping` - Check daemon connectivity
- `daemon` - Start daemon in foreground
- `stop` - Stop daemon

## Daemon HTTP endpoints

The CLI talks to the daemon over HTTP on a UNIX socket.

- Socket path env var: `COCOD_SOCKET`
- Default socket: `~/.cocod/cocod.sock`

### Response shape

- Success: `{ "output": <value> }`
- Error: `{ "error": "message" }`

### Endpoint list

- `GET /ping`
- `GET /status`
- `POST /init`
- `POST /unlock`
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
- `POST /stop`

For full request/response and status details, see `docs/daemon-api.json`.
