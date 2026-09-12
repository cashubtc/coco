# Receive ecash

Decode with `coco.wallet.decodeToken(encodedToken)`, show its mint and unit, and resolve trust
before preparing. Decoding validates the encoded input; it does not prove the proofs remain
spendable. After the mint trust decision:

```ts
const prepared = await coco.ops.receive.prepare({ token: encodedToken });
// Show prepared.amount, prepared.unit, and prepared.fee; await user confirmation.
const received = await coco.ops.receive.execute(prepared.id);
```

Persist or retain `prepared.id` for resuming this screen. Render completion from the finalized
operation, not from decoding or scanning the token. If the user abandons a prepared receive,
call `coco.ops.receive.cancel(prepared.id)`.

For a locked token, also read [P2PK](p2pk.md) before receiving. For state-specific actions, see
[Receive Operations](https://cashubtc.github.io/coco/pages/receive-operations).

**Done when:** a valid token finalizes into local proofs, an already spent or invalid token gives
an actionable result, and an interrupted receive resumes by its operation ID.
