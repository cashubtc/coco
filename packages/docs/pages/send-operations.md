# Send Operations

Coco implements send operations as a **saga** - a series of discrete steps that can be recovered from crashes and rolled back if needed. This provides strong guarantees around fund safety.

## Overview

The send operation saga provides:

- **Crash Recovery**: Operations are recoverable after application crashes
- **Rollback Support**: Cancel pending sends and reclaim your proofs
- **Fee Transparency**: Know the exact fee before committing

## Operation States

Send operations progress through the following states:

| State | Description |
|-------|-------------|
| `init` | Operation created, nothing reserved yet |
| `prepared` | Proofs reserved, fee calculated, ready to execute |
| `executing` | Swap in progress (if needed) |
| `pending` | Token created, waiting for recipient to claim |
| `completed` | Recipient claimed, operation finalized |
| `rolling_back` | Rollback in progress |
| `rolled_back` | Operation cancelled, proofs reclaimed |

```
init ──► prepared ──► executing ──► pending ──► completed
  │         │            │            │
  │         │            │            └──► rolling_back ──► rolled_back
  │         │            │                      │
  └─────────┴────────────┴──────────────────────┴──► rolled_back
```

## Using the Send API

### Prepare → Execute Flow

The recommended flow separates preparation from execution, allowing you to show fees before committing:

```ts
// Step 1: Prepare (reserves proofs, calculates fee)
const prepared = await coco.send.prepareSend(mintUrl, 100);

// Show user the fee
console.log('Fee:', prepared.fee, 'sats');
console.log('Total input:', prepared.inputAmount, 'sats');
console.log('Requires swap:', prepared.needsSwap);

// Step 2: User confirms → Execute
const { operation, token } = await coco.send.executePreparedSend(prepared.id);

// Step 3: Share token with recipient
shareToken(token);
```

### Cancelling a Prepared Send

If the user decides not to proceed after seeing the fee:

```ts
const prepared = await coco.send.prepareSend(mintUrl, 100);

// User cancels
await coco.send.rollback(prepared.id);
// Proofs are released and available again
```

### Reclaiming Unclaimed Tokens

After executing a send, if the recipient never claims the token:

```ts
// Get the operation (from history or stored operationId)
const operation = await coco.send.getOperation(operationId);

if (operation?.state === 'pending') {
  // Reclaim the proofs
  await coco.send.rollback(operationId);
}
```

> **Note:** Reclaiming requires a swap, which incurs fees. The reclaimed amount will be less than the original send amount.

## Querying Operations

### Get a Specific Operation

```ts
const operation = await coco.send.getOperation(operationId);

if (operation) {
  console.log('State:', operation.state);
  console.log('Amount:', operation.amount);
  console.log('Created:', new Date(operation.createdAt));
}
```

### List Pending Operations

```ts
const pending = await coco.send.getPendingOperations();

for (const op of pending) {
  console.log(`${op.id}: ${op.amount} sats (${op.state})`);
}
```

## Automatic Finalization

When [ProofStateWatcher](./watchers-processors.md) is enabled (default), send operations are automatically finalized when the mint reports the send proofs as spent. This happens when:

1. The recipient successfully receives the token
2. The mint notifies Coco via WebSocket or polling

You can listen for this:

```ts
coco.on('send:finalized', ({ operationId, operation }) => {
  console.log(`Send ${operationId} completed!`);
});
```

## Crash Recovery

On startup, Coco automatically recovers pending operations:

```ts
// This is called automatically by initializeCoco()
// If using Manager directly, call it manually:
await coco.send.recoverPendingOperations();
```

### Recovery Behavior by State

| State | Recovery Action |
|-------|-----------------|
| `init` | Cleaned up (deleted) |
| `prepared` | Left as-is; user can rollback manually |
| `executing` | Checks mint for swap status, recovers proofs if needed |
| `pending` | Checks if proofs are spent; finalizes or leaves pending |
| `rolling_back` | Warns; may need manual seed restore |

### Executing State Recovery

The `executing` state is the most critical for recovery. If a crash occurs during a swap:

1. **Swap didn't happen**: Proofs are released, operation rolled back
2. **Swap completed**: Output proofs are recovered via the mint's restore endpoint

This ensures no funds are lost even if the app crashes mid-swap.

## Events

```ts
// Operation prepared (proofs reserved)
coco.on('send:prepared', ({ mintUrl, operationId, operation }) => {
  console.log('Prepared:', operation.amount, 'sats');
});

// Token created (waiting for recipient)
coco.on('send:pending', ({ mintUrl, operationId, operation, token }) => {
  console.log('Token ready');
});

// Recipient claimed
coco.on('send:finalized', ({ mintUrl, operationId, operation }) => {
  console.log('Completed');
});

// Rolled back
coco.on('send:rolled-back', ({ mintUrl, operationId, operation }) => {
  console.log('Cancelled');
});
```

## History Integration

Send operations automatically create history entries. You can access them via the History API:

```ts
const history = await coco.history.getHistory();

for (const entry of history) {
  if (entry.type === 'send') {
    console.log(`Send: ${entry.amount} sats, state: ${entry.state}`);
    console.log(`Operation ID: ${entry.operationId}`);
    
    // For pending sends, you can rollback using the operationId
    if (entry.state === 'pending') {
      // await coco.send.rollback(entry.operationId);
    }
  }
}
```

## Best Practices

### Always Handle Prepared Operations

If a user closes your app after `prepareSend()` but before executing or rolling back, the proofs remain reserved. Handle this on next launch:

```ts
// On app start
const pending = await coco.send.getPendingOperations();
const prepared = pending.filter(op => op.state === 'prepared');

if (prepared.length > 0) {
  // Either resume or clean up
  for (const op of prepared) {
    // Option 1: Let user decide
    showPendingOperationDialog(op);
    
    // Option 2: Auto-rollback stale operations
    if (Date.now() - op.createdAt > 24 * 60 * 60 * 1000) {
      await coco.send.rollback(op.id);
    }
  }
}
```

### Store Operation IDs

When displaying a pending send to users, store the `operationId` so you can rollback later:

```ts
const prepared = await coco.send.prepareSend(mintUrl, amount);
const { operation, token } = await coco.send.executePreparedSend(prepared.id);

// Store for later rollback capability
savePendingSend({
  operationId: operation.id,
  token: token,
  createdAt: operation.createdAt,
});
```

### Handle Network Failures

Prepare and execute can fail if the mint is unreachable:

```ts
try {
  const prepared = await coco.send.prepareSend(mintUrl, amount);
  const result = await coco.send.executePreparedSend(prepared.id);
} catch (error) {
  // If prepare succeeded but execute failed, rollback
  if (prepared) {
    await coco.send.rollback(prepared.id);
  }
  throw error;
}
```

