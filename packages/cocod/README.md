# cocod

`cocod` is a Cashu wallet CLI with a local daemon, built on the Coco packages in this
workspace.

If you like simple tools: run commands in your terminal, and let the daemon handle wallet state in the background.

## What it does

- Initialize and secure a Cashu wallet
- Check balances and transaction history
- Send and receive Cashu tokens
- Send and receive Lightning payments (BOLT11)
- Handle HTTP 402 payments with `X-Cashu`
- Manage trusted mints

## Install

The package is private and runs from workspace source. From the repo root:

```bash
bun install
bun run build            # cocod resolves @cashu/coco-* through their dist/ exports
bun packages/cocod/src/index.ts --help
```

To get a global `cocod` command, link the package:

```bash
cd packages/cocod && bun link
```

Note: the `coco-cashu-plugin-npc` dependency currently declares an exact peer on a
`@cashu/coco-core` release candidate, so `bun install` prints an unmet-peer warning
against the workspace core. Install still succeeds; the plugin is due to be re-cut
with a range peer.

## Quick start

```bash
# Check daemon status
cocod status

# Create a Wallet and display its host-generated recovery material
cocod wallet initialize

# Display the recovery material again if the initialization response was lost
cocod wallet recovery-material

# Start a Coco Session for a passphrase-protected Wallet
cocod session start --passphrase "your-passphrase"

# Check balance
cocod balance
```

The CLI connects to `http://127.0.0.1:62626` by default and automatically starts a local Cocod
Process when that implicit endpoint is unavailable. Use `cocod --url <origin> <command>` or set
`COCOD_URL` to select an existing local or remote process; explicit endpoints are client-only and
are never auto-started.

Listener overrides apply when starting `cocod daemon` explicitly. An auto-started process always
uses the implicit local default, so custom listeners should be started explicitly and paired with
`--url` or `COCOD_URL` for clients.

## Most common commands

```bash
# Receive
cocod receive cashu "cashuA..."
cocod receive bolt11 1000

# Send
cocod send cashu 500
cocod send bolt11 "lnbc..."

# Mints
cocod mints add https://mint.example.com/Bitcoin
cocod mints list

# History
cocod history --limit 10
cocod history --watch

# Logs
cocod logs
cocod logs --follow
cocod logs --path
```

## NPC (Lightning Address)

```bash
# Your NPC address
cocod npc address

# Check username price, then confirm purchase
cocod npc username myname
cocod npc username myname --confirm
```

## HTTP 402 / X-Cashu

```bash
# Inspect request from a 402 response
cocod x-cashu parse "<encoded-x-cashu-request>"

# Settle and get header value for retry
cocod x-cashu handle "<encoded-x-cashu-request>"
```

Cocod accepts `creqA` and `creqB` requests. NUT-10 spending conditions are handled by
Coco: P2PK-locked requests are paid with locked outputs, while unsupported or malformed
conditions are rejected with a clear error before any proofs move.

## Upgrading from 0.0.16 or earlier

The wallet database migrates in place on first start. Migrations are one-way; if you want a
rollback path to the previous release, copy `~/.cocod/coco.db` somewhere safe before
upgrading and delete the copy once you're settled.

## How it works

- CLI: `src/cli.ts`
- Daemon: `src/daemon.ts`
- Routes: `src/routes.ts`
- Transport: authenticated HTTP over one TCP listener

Defaults:

- Listener: `127.0.0.1:62626`
- Listener overrides: `COCOD_LISTEN_HOST` and `COCOD_LISTEN_PORT`
- Client endpoint override: `--url <origin>` or `COCOD_URL`
- PID file: `~/.cocod/cocod.pid` (or `COCOD_PID`)
- Process ownership lease: `~/.cocod/daemon-lock.sqlite`
- Daemon log: `~/.cocod/daemon.log` (or `COCOD_LOG_FILE`)
- Config: `~/.cocod/config.json`
- Database: `~/.cocod/coco.db`

The lease database contains no Wallet data. Cocod keeps one exclusive SQLite transaction open for
the process lifetime, so a second process cannot share the state directory and process termination
releases ownership automatically.

Logging defaults:

- Structured JSON logs are written to `~/.cocod/daemon.log`
- Rotation keeps 5 files at 5 MiB each by default
- Override with `COCOD_LOG_LEVEL`, `COCOD_LOG_MAX_BYTES`, and `COCOD_LOG_MAX_FILES`

Every route except `/health` requires the administrative bearer credential stored in the
mode-`0600` client file under `~/.cocod/credentials/current/client`.
`daemon`, `logs`, and `credential rotate` are host-local commands and reject an explicit endpoint;
`stop` works against either the implicit local process or an explicit remote endpoint.

For remote deployments, keep authentication in cocod and terminate TLS at a trusted proxy such as
Caddy:

```caddyfile
wallet.example.com {
  reverse_proxy 127.0.0.1:62626
}
```

Cocod does not provide native TLS or browser CORS support. A proxy supplies transport security but
does not replace the Cocod Client Credential, and forwarded identity headers are ignored.

## Development

From `packages/cocod` (run `bun run build` at the repo root first):

```bash
# Run CLI from source
bun src/index.ts --help

# Run daemon directly
bun run daemon

# Typecheck
bun run typecheck

# Tests
bun test
```

## Docs

- [API and command reference](docs/API.md)
- [Machine-readable daemon contract](docs/daemon-api.json)
- [Network interface v1](docs/network-interface-v1.md)

## License

MIT
