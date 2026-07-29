# cocod

`cocod` is a Cashu wallet CLI with a local daemon.

If you like simple tools: run commands in your terminal, and let the daemon handle wallet state in the background.

## What it does

- Initialize and secure a Cashu wallet
- Check balances and transaction history
- Send and receive Cashu tokens
- Send and receive Lightning payments (BOLT11)
- Handle HTTP 402 payments with `X-Cashu`
- Manage trusted mints

## Install

```bash
bun install --global cocod
```

Or from source:

```bash
git clone <repository-url>
cd cocod
bun install
```

## Quick start

```bash
# Check daemon status
cocod status

# Create a wallet (auto-generates mnemonic)
cocod init

# If encrypted during init, unlock it
cocod unlock "your-passphrase"

# Check balance
cocod balance
```

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

## How it works

- CLI: `src/cli.ts`
- Daemon: `src/daemon.ts`
- Routes: `src/routes.ts`
- IPC transport: HTTP over UNIX socket

Defaults:

- Socket: `~/.cocod/cocod.sock` (or `COCOD_SOCKET`)
- PID file: `~/.cocod/cocod.pid` (or `COCOD_PID`)
- Daemon log: `~/.cocod/daemon.log` (or `COCOD_LOG_FILE`)
- Config: `~/.cocod/config.json`
- Database: `~/.cocod/coco.db`

Logging defaults:

- Structured JSON logs are written to `~/.cocod/daemon.log`
- Rotation keeps 5 files at 5 MiB each by default
- Override with `COCOD_LOG_LEVEL`, `COCOD_LOG_MAX_BYTES`, and `COCOD_LOG_MAX_FILES`

## Development

```bash
# Run CLI from source
bun src/index.ts --help

# Run daemon directly
bun run daemon

# Typecheck
bun run lint

# Tests
bun test

# Isolated daemon smoke test
bun run smoke:daemon
```

## Docs

- [API and command reference](docs/API.md)
- [Machine-readable daemon contract](docs/daemon-api.json)

## License

MIT
