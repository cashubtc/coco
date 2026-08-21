# Cocod Network Interface v1 — Bruno collection

This collection translates the protocol contract in
[`network-interface-v1.md`](../docs/network-interface-v1.md) into runnable requests. Its
implemented-route coverage is checked against
[`lifecycle-api-v1.json`](../docs/lifecycle-api-v1.json) (cocod 0.0.17, interface
version 1). It also separates the remaining legacy compatibility routes and
the accepted-but-proposed v1 resources.

## Setup

1. Open this directory as a collection in Bruno.
2. Select the `local` environment.
3. Set the secret `clientCredential` from the host-local credential file
   (normally `~/.cocod/credentials/current/client`).
4. Replace the example `mintUrl` and other ordinary environment values.
5. Set secret request inputs only when needed: `walletPassphrase`, `bolt11Invoice`,
   `bolt12Offer`, `cashuToken`, and `paymentRequest`.

The collection stores no secret values in Git. Create requests capture Quote and Operation IDs as
ephemeral runtime variables, so the corresponding inspect and command requests can be run next.

## Safety

Do not run the entire collection blindly. Requests tagged `financial`, `mutation`, `sensitive`,
or `shutdown` can reserve proofs, move funds, reveal recovery material, change lifecycle state,
or stop cocod. Operation preparation is durable and is not a dry run.

The random `Idempotency-Key` header on supported mutations is disabled by default. Enable it for
a deliberate retry; keep the same concrete key when retrying the same request. Idempotency records
last only for the current Cocod Process.

The `Proposed Resources` folder documents the accepted target paths but they are not callable in
the current implementation. The unsupported Mint and Receive result requests intentionally
demonstrate the specified `not_found` behavior.

## Regeneration

From `packages/cocod`:

```sh
bun run generate:bruno
bun run check:bruno
```
