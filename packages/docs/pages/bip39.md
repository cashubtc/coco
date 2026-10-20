# Bip39

Coco is a deterministic wallet by default. That means it will only work when given a BIP-39 compatible seed. The seed will be used to derive keys and secrets internally

## Seed Getter

The BIP-39 seed is never persisted by coco, instead it needs to be supplied via a `seedGetter` function that is passed at instantiation:

```ts
import { initializeCoco } from '@cashu/coco-core';

async function seedGetter(): Promise<Uint8Array> {
  // Add your implementation here
}

const coco = await initializeCoco({
  repo, // See storage adapters to learn more
  seedGetter,
});
```

Coco will call this function whenever it needs to access the seed

## Restore

Once instantiated you can use the deterministic secret restore `coco.wallet.restore()` to restore secrets and counters based on the seed on a certain mint. Coco will get all available keysets from the mint and perform a restore for each one, including custom-unit keysets.

```ts
await coco.wallet.restore('https://mint.url');
// Discovered proofs and counters are committed together for each keyset.
// Note: Restore will automatically cache the mint info if not already present
```

To restore only selected units, pass a unit filter:

```ts
await coco.wallet.restore('https://mint.url', { units: ['usd'] });
```

> **Note:** The `restore()` method will add and trust the mint automatically. If you want to display mint info to the user before proceeding use `addMint()` as described in [Adding a Mint](../starting/adding-mints.md)

Restore adds missing proofs without deleting local proofs or lowering the stored output counter.
Repeating it preserves existing proof state and operation ownership. Each keyset commits independently;
a failure on a later keyset leaves earlier successful keysets committed.

Newly discovered proofs that the mint reports as `PENDING` are stored as `pending`, excluded from
spendable, reserved, and total balances. Repeat Restore to reconcile them: unowned pending proofs
become `ready` on `UNSPENT` or `spent` on `SPENT`. Until then, they remain unavailable. Automatic
pending-proof watching is deferred to a follow-up. Missing proofs already reported as `SPENT` are
not imported.

## Sweep

Sweep exchanges a source Wallet Seed's available proofs into the current Wallet through ordinary
Receive operations. It adds and trusts the mint automatically, and creates ordinary Receive history.
Only `UNSPENT` proofs are exchanged. `PENDING` proofs are skipped and may be swept later if they become
available; `SPENT` proofs are excluded.

```ts
// Input validation and mint setup can reject before keyset processing starts.
const report = await coco.wallet.sweep('https://mint.url', oldSeed, { units: ['usd'] });
for (const result of report.keysets) {
  console.log(result.keysetId, result.unit, result.status);
  if (result.pending) {
    console.log('Skipped pending:', result.pending.count, result.pending.amount.toString());
  }
  if (result.status === 'transferred') {
    console.log('Received:', result.received.toString(), result.unit, result.receiveOperationId);
  } else if (result.status === 'failed') {
    console.error('Keyset failed:', result.keysetId, result.error);
  } else if (result.status === 'unresolved') {
    const operation = await coco.ops.receive.get(result.receiveOperationId);
    console.log('Inspect existing Receive before retrying:', operation);
  }
}
```

Omit `units` to process every advertised unit. Each entry in `SweepReport.keysets` identifies its
keyset and unit; amounts use cashu-ts `Amount` without combining units.

| Status        | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `transferred` | Receive finalized; includes its ID, net `received` amount, and `fee`                                                         |
| `noop`        | No available or pending proofs (empty or fully spent discovery)                                                              |
| `skipped`     | `reason: 'pending'`, or `reason: 'uneconomic'` with available amount and fee when value cannot cover fees                    |
| `failed`      | Discovery/preparation failed, or public Receive state confirms rollback; includes the error and an operation ID if available |
| `unresolved`  | Receive exists but completion could not be established; includes its ID and the execution error                              |

`pending: { count, amount }` is present after successful discovery, including when available value
was transferred or a later step failed. Its amount uses the entry's unit. It is absent if discovery
could not establish the observations. A preparation failure can occur before an operation ID is
returned, so a failed result does not always include one.

Keysets are attempted independently. Once processing starts, Sweep returns the complete report,
even if every keyset fails or remains unresolved. Earlier transfers remain committed. A resolved
call does not mean that value was transferred: callers must inspect each result's `status`.
Mint setup or invalid options can reject before keyset processing without a report.

Plugins calling `walletRestoreService.sweepKeyset()` directly must also inspect the result.
Discovery and exchange failures are returned as `failed` or `unresolved`; invalid mint URLs or units
still reject before discovery. This replaces the earlier exception-based failure contract.

Receive recovery reconciles existing submitted exchanges, including after restart. Prepared operations
follow Receive's normal resume/cancellation policy. Sweep does not resume discovery or unvisited
keysets, watch pending proofs, or automatically replace an unresolved exchange. A later Sweep call
can rediscover inputs belonging to an unresolved Receive: inspect and reconcile the existing operation
before retrying rather than assuming cross-call deduplication.
