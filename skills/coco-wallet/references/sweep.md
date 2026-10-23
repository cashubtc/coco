# Sweep another Wallet Seed

Use Sweep to exchange a source Wallet Seed's available proofs into the current Wallet. Use
[Wallet Import and Restore](restore.md) when reopening the source Wallet under its own identity.
The destination Coco Session keeps its existing `seedGetter`; pass the source seed only to Sweep.
Obtain approval for the selected mint: Sweep adds and trusts it automatically.

```ts
const report = await coco.wallet.sweep(mintUrl, sourceSeed, { units: ['sat'] });
for (const result of report.keysets) {
  if (result.status === 'transferred') {
    // Show result.received and result.fee in result.unit; retain result.receiveOperationId.
  } else if (result.status === 'unresolved') {
    const operation = await coco.ops.receive.get(result.receiveOperationId);
    // Resume this Receive operation before offering another Sweep of the same source.
  }
  // Render every other status and any result.pending observations as described below.
}
```

Omit `units` to process all advertised keyset units, or use the user's unit selection. Sweep
executes exchanges immediately; confirm the source, destination Wallet, mint, and unit scope
before calling it. There is no public prepare/confirm stage for reviewing each exchange's exact fee.
Amounts in the report are `Amount` values scoped to each keyset's unit; display them with
`.toString()` and keep different units separate.

## Interpret the complete report

Once keyset processing starts, the promise resolves with a `SweepReport` even if every keyset
fails or remains unresolved. Input validation and mint setup can still reject before a report
exists. Inspect every result rather than treating promise resolution as successful transfer:

| Status        | UI and follow-up                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `transferred` | Show net `received`, `fee`, and the ordinary Receive operation/history entry.                                       |
| `noop`        | Discovery found no available or pending value.                                                                      |
| `skipped`     | `reason: 'pending'` means no inputs are currently available; `reason: 'uneconomic'` includes `available` and `fee`. |
| `failed`      | Show the keyset failure; retain `receiveOperationId` when available. Other keysets may have succeeded.              |
| `unresolved`  | Keep the Receive ID and reconcile it through `ops.receive.get()`, `refresh()`, or recovery before retrying.         |

`pending: { count, amount }` is present after successful discovery, including alongside a
successful transfer or later failure. Pending proofs are skipped; spent proofs are excluded.
A later Sweep can discover newly available value, but it can also rediscover inputs belonging
to an unresolved Receive. Reconcile existing exchanges first; separate Sweep calls are not
automatically deduplicated against them.

Receive owns exchange settlement and Operation Recovery. Startup recovery can reconcile submitted
exchanges; it does not resume Sweep discovery or unvisited keysets. Prepared Receive operations
still need the normal execute/cancel decision. Earlier keyset transfers survive a later failure.
Read [Receive ecash](ecash-receive.md) for the operation lifecycle.

**Done when:** the UI reports every keyset outcome and skipped amount, preserves unit boundaries,
and an interrupted exchange resumes its Receive operation before any source is swept again.
