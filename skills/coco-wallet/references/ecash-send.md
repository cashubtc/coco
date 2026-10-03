# Send ecash

```ts
const prepared = await coco.ops.send.prepare({ mintUrl, amount: 100 });
// Show prepared.amount, prepared.unit, prepared.fee, and prepared.inputAmount.
// After user confirmation:
const { operation, token } = await coco.ops.send.execute(prepared.id);
const encodedToken = coco.wallet.encodeToken(token);
```

`token` is a Token object; encode it before displaying it as text, copying it, or generating a QR.
The resulting operation is `pending`: the token is ready to share but the recipient has not yet
been confirmed to have claimed it. Observe `send:finalized` for completion.

Use `ops.send.cancel(id)` for a prepared send and `ops.send.reclaim(id)` for an unclaimed pending
send. Reclaim can incur a fee or lose a race with the recipient; show its actual result. Keep
the operation ID so navigating away does not strand reserved or pending value.

For recipient locks, also read [P2PK](p2pk.md). For state-specific actions, see
[Send Operations](https://cashubtc.github.io/coco/pages/send-operations).

**Done when:** the user can review fees, cancel before execution, share an encoded token, and
resume a pending send without confusing token creation with recipient claim.
