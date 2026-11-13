# Mint Swap Operations

Mint Swap moves an exact sat amount from one trusted mint to another through a durable parent
operation. The parent coordinates one exact source Melt Operation and one exact destination Mint
Operation. It does not duplicate or own their state.

## Prerequisites

- Use two distinct, normalized mint URLs. Both mints must be trusted and support BOLT11 in `sat`.
- Give each user intent a stable caller-owned ID. Reusing an ID is idempotent only for the same
  normalized intent.
- Let only one effect-driving Coco Session use a Wallet store at a time. In-memory operation locks
  do not fence another process or browser context.

## Prepare, approve, and execute

Preparation fixes the exact children, reserves the source inputs, and persists debit bounds. It
never pays the source invoice. Only an explicit `execute` authorizes that initial payment.

```ts
const prepared = await coco.ops.mintSwap.prepare({
  id: 'stable-swap-id',
  sourceMintUrl,
  destinationMintUrl,
  destinationAmount: { amount: 1_000, unit: 'sat' },
  sourceDebitCap: { amount: 1_020, unit: 'sat' },
});

if (prepared.state === 'prepared') {
  showApproval({
    destinationAmount: prepared.destinationAmount,
    minimumDebit: prepared.sourceDebitBounds.minimum,
    maximumDebit: prepared.sourceDebitBounds.maximum,
  });
  await coco.ops.mintSwap.execute(prepared.id);
}
```

Do not recompute missing economics in application code. A completed operation records the final
source debit, returned value, total fee, canonical destination issuance, and exact stored proof
total. Before those facts are established, display the persisted bounds or leave the value absent;
an absent value is not zero.

## Observation and recovery

- `get(id)` and `listActive()` are local reads.
- `waitForOutcome(id, options)` passively observes. Its `timeout` result is local and does not
  change the persisted operation.
- `refresh(id)` is effect-driving recovery for already prepared or authorized work.
- `recovery.run()` is an explicit Manager-level recovery sweep.
- `cancel(id)` records cancellation intent. An ambiguous or paid source may still need to recover
  forward before a safe outcome is known.

The Mint Swap processor is enabled by default. It rebuilds watcher interests and advances eligible
parents from canonical observations. Disabling it stops automatic parent scans; explicit commands
remain available. An untouched `prepared` parent is never paid automatically.

`mint-swap:updated` contains only `{ operationId, revision, state }` and is a best-effort hint. It
can be lost, duplicated, or reordered, so reread the operation and order parent snapshots by
`revision`. React consumers can use `useMintSwapOperation`, which performs passive local rereads and
polling but never schedules `execute`, `refresh`, or recovery.

## Parent and child ownership

While the parent can act, ordinary commands that would mutate either exact child reject with
`MintSwapChildOperationError`. Reads and quote observations remain legal. Once the parent is
`completed`, `cancelled`, `failed`, or `needs_attention`, a child may resolve through its ordinary
workflow, but it cannot revise the stopped parent or authorize its source payment.

`completed`, `cancelled`, `failed`, and `needs_attention` are quiescent parent outcomes.
`needs_attention` is not successful settlement and requires application review.

## Grouped history

History lists represent one Mint Swap intent as one `mint-swap:<parentId>` row and suppress its
exact `melt:<sourceChildId>` and `mint:<destinationChildId>` rows. Direct lookup of all three IDs
still works. Unlinked ordinary Mint and Melt operations remain visible.

The row aliases `mintUrl` to the destination mint and `amount` to the requested destination amount.
Active and completed rows expose `progress.provenance: 'current'`; stopped rows expose the immutable
`last_safe` checkpoint. `parentRevision` orders parent state, while child changes may advance the
row's `updatedAt` without changing that revision. Lists remain ordered by `createdAt`, then ID, and
adapters group before pagination.

The public row excludes quotes, invoices, hashes, preimages, signing material, output plans,
proofs, tokens, retry internals, and raw errors. Treat `history:updated` as an invalidation: reread
the current page or loaded window instead of splicing the event entry into a sorted page.
