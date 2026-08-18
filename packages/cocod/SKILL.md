---
name: cocod
description: A Cashu ecash wallet CLI for Bitcoin and Lightning payments. Use when managing Cashu tokens, sending/receiving payments via Lightning (bolt11 invoices or bolt12 offers) or ecash, handling HTTP 402 X-Cashu payment requests, or viewing wallet history.
compatibility: Requires the cocod CLI, a private package in this repository that runs from workspace source (packages/cocod). Supports Cashu ecash protocol, Lightning Network payments, and NUT-24 HTTP 402 X-Cashu flows.
metadata:
  project: cocod
  type: cashu-wallet
  skill_version: 0.0.17
  requires_cocod_version: 0.0.17
  networks:
    - cashu
    - bitcoin
    - lightning
---

# Cocod - Cashu Wallet CLI

Cocod is a Cashu wallet for managing ecash tokens and making Bitcoin/Lightning payments. It uses the Cashu protocol for privacy-preserving ecash transactions.

If a web/API request returns HTTP `402 Payment Required` with an `X-Cashu` header, use this skill to parse and settle the request with cocod.

## Agent Safety Policy (Required)

When acting as an AGENT with this skill:

- Always ask for explicit user permission before running any command/flow that can spend wallet funds, unless the user has already clearly instructed you to execute that spend action.
- Prefer preview/inspection commands before execution whenever available. For example, run `cocod x-cashu parse <request>` to inspect costs and requirements before `cocod x-cashu handle <request>`.
- Treat `~/.cocod` as sensitive. Never log, print, or expose its contents (including config, mnemonic material, wallet state, sockets, and pid files) unless the user explicitly requests a specific safe subset.
- Always surface issues and errors encountered while using the CLI or this skill. Do not hide failures behind partial success messaging.
- Do not manually work around CLI issues, missing behavior, or unexpected command failures without explicit user permission.

## What is Cashu?

Cashu is a Chaumian ecash protocol that lets you hold and transfer Bitcoin-backed tokens privately. It enables unlinkable transactions using blind signatures.

## Installation

The package is private and runs from workspace source. From the repo root:

```bash
bun install
bun run build            # cocod resolves @cashu/coco-* through their dist/ exports
cd packages/cocod && bun link   # provides a global `cocod` command
```

Alternatively, install the last standalone release from npm:

```bash
bun install -g cocod
```

## Version Compatibility

This skill is version-pinned to an exact `cocod` version.

- `metadata.skill_version` must match the version in `packages/cocod/package.json`.
- `metadata.requires_cocod_version` is pinned to that exact same version.

Check your installed CLI version:

```bash
cocod --version
```

If the version does not match the pinned values in this file, update `cocod` before using this skill — rebuild and relink if installed from the workspace, or update the npm install.

## Quick Start

```bash
# Initialize your wallet (generates mnemonic automatically)
cocod init

# Or with a custom mint
cocod init --mint-url https://mint.example.com

# Check balance
cocod balance
```

## Commands

### Core Wallet

```bash
# Check daemon and wallet status
cocod status

# Initialize wallet with optional mnemonic
cocod init [mnemonic] [--passphrase <passphrase>] [--mint-url <url>]

# Unlock encrypted wallet (only required when initialised with passphrase)
cocod unlock <passphrase>

# Get wallet balance
cocod balance

# Test daemon connection
cocod ping
```

### Receiving Payments

```bash
# Receive Cashu token
cocod receive cashu <token>

# Create Lightning invoice to receive
cocod receive bolt11 <amount> [--mint-url <url>]

# Get a reusable BOLT12 offer to receive
cocod receive bolt12 [--amount <sats>] [--mint-url <url>]

# List the offers that can still be paid
cocod receive bolt12 list
```

A BOLT12 offer keeps working after it is paid, so one offer can be handed out repeatedly.
Payments are claimed in the background, so no follow-up command is needed; use `cocod history`
to check whether an offer was paid. `cocod receive bolt12 list` reports each offer with the
amount the mint has received against it and the amount this wallet has already claimed.

### Sending Payments

AGENT rule: commands in this section spend wallet funds. Ask for permission first unless the user already explicitly requested the spend action.

```bash
# Create Cashu token to send to someone
cocod send cashu <amount> [--mint-url <url>]

# Pay a Lightning invoice
cocod send bolt11 <invoice> [--mint-url <url>]

# Pay a BOLT12 offer (--amount is required for offers without a fixed amount)
cocod send bolt12 <offer> [--amount <sats>] [--mint-url <url>]
```

`cocod send bolt12` prints the amount plus the fee reserve, which is spent on top of it.

An unconfirmed payment must NOT be retried — every payment to a BOLT12 offer is a separate
invoice, so retrying pays the payee twice. Report it as unconfirmed, quote the operation id,
and check `cocod history`.

### HTTP 402 Web Payments (NUT-24)

Use these commands when a server responds with HTTP `402` and an `X-Cashu` payment request.

AGENT rule: `cocod x-cashu handle <request>` can spend funds. Prefer `cocod x-cashu parse <request>` first to preview amount/requirements, then ask permission before handling unless already instructed.

Compatibility: cocod accepts `creqA` and `creqB` requests. Coco enforces NUT-10 spending
conditions: P2PK-locked requests are paid with locked outputs, and unsupported or malformed
conditions fail with a 400 before any proofs move.

```bash
# Parse an encoded X-Cashu request from a 402 response header
cocod x-cashu parse <request>

# Settle the request and get an X-Cashu payment header value
cocod x-cashu handle <request>
```

Typical flow:

1. Read `X-Cashu` from the `402` response.
2. Run `cocod x-cashu parse <request>` to inspect amount and mint requirements.
3. Run `cocod x-cashu handle <request>` to generate payment token header value.
4. Retry the original web request with returned `X-Cashu: cashuB...` header.

### Mints

```bash
# Add a mint URL
cocod mints add <url>

# List configured mints
cocod mints list

# Get mint information
cocod mints info <url>
```

### Lightning Address (NPC)

Lightning Addresses are email-style identifiers (like `name@npubx.cash`) that let others pay you over Lightning. If you have not purchased a username, NPC provides a free address from your Nostr npub; purchasing a username gives you a human-readable handle. Buying a username is a two-step flow so you can review the required sats before confirming payment.

AGENT rule: `cocod npc username <name> --confirm` is a spend action. Ask permission before running `--confirm` unless already instructed.

```bash
# Get your NPC Lightning Address
cocod npc address

# Reserve/buy an NPC username (two-step)
cocod npc username <name>
cocod npc username <name> --confirm
```

### History

```bash
# View wallet history
cocod history

# With pagination
cocod history --offset 0 --limit 20

# Watch for real-time updates
cocod history --watch

# Limit with watch
cocod history --limit 50 --watch
```

### Daemon Control

```bash
# Start the background daemon (started automatically when not running when required)
cocod daemon

# Stop the daemon
cocod stop
```

## Examples

**Initialize with encryption:**

```bash
cocod init --passphrase "my-secret"
```

**Receive via Lightning:**

```bash
cocod receive bolt11 5000
# Returns: lnbc50u1... (share this invoice to receive)
```

**Pay a Lightning invoice:**

```bash
cocod send bolt11 lnbc100u1p3w7j3...
```

**Send Cashu to a friend:**

```bash
cocod send cashu 1000
# Returns: cashuAeyJ0b2tlbiI6...
# Friend receives with: cocod receive cashu cashuAeyJ0b2tlbiI6...
```

**Check status and balance:**

```bash
cocod status
cocod balance
```

**View recent history:**

```bash
cocod history --limit 10
```

## Concepts

- **Cashu**: Privacy-preserving ecash protocol using blind signatures
- **Mint**: Server that issues and redeems Cashu tokens
- **Token**: Transferable Cashu string representing satoshi value
- **Bolt11**: Lightning Network invoice format, payable once
- **Bolt12**: Lightning Network offer format, reusable across payments
- **NPC**: Lightning Address service for receiving payments
- **Mnemonic**: Seed phrase for wallet recovery
