# Receive Operations

Receive operations turn an encoded Cashu token into proofs stored in the local
wallet. The operation API makes receiving explicit so apps can review decoded
token details and recover the same persisted operation after crashes.

## API Surface (`coco.ops.receive`)

The canonical API is exposed through `coco.ops.receive`:

- `prepare({ token })` decodes and validates a token, calculates fees, and
  creates deterministic receive outputs; it does not deduplicate completed tokens
- `execute(operationOrId)` receives the prepared token and saves the new proofs
- `get(operationId)` returns a persisted receive operation
- `listPrepared()` lists receives waiting for user confirmation
- `listInFlight()` lists receives that may need recovery
- `refresh(operationId)` recovers an executing receive and returns the latest
  operation state
- `cancel(operationId, reason?)` rolls back an `init` or `prepared` receive

## Operation States

Receive operations progress through the following states:

| State         | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| `init`        | Token decoded and validated, but outputs are not prepared yet |
| `prepared`    | Fees calculated, output data persisted, ready to execute      |
| `executing`   | Receive request is in progress at the mint                    |
| `finalized`   | New proofs were saved locally                                 |
| `rolled_back` | Operation was cancelled or could not be recovered             |

```
init -> prepared -> executing -> finalized
  |        |             |
  +--------+-------------+-> rolled_back
```

## Lifecycle Actions

| Action                         | Valid input state                  | Resulting state                            | Use when                                                                 |
| ------------------------------ | ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `prepare({ token })`           | none                               | `prepared`                                 | You want to inspect token amount, mint, unit, and fees before receiving. |
| `execute(operationOrId)`       | `prepared`                         | `finalized`                                | The user confirmed the receive and proofs should be saved.               |
| `refresh(operationId)`         | any, actively recovers `executing` | latest stored state                        | You are resuming an operation after a crash or stale UI state.           |
| `cancel(operationId, reason?)` | `init`, `prepared`                 | `rolled_back` or deleted when still `init` | The user abandons the receive before it completes.                       |

## Prepare -> Execute Flow

```ts
const prepared = await coco.ops.receive.prepare({ token });

console.log('Amount:', prepared.amount);
console.log('Mint:', prepared.mintUrl);
console.log('Fee:', prepared.fee);

if (userConfirmed) {
  const finalized = await coco.ops.receive.execute(prepared.id);
  console.log('Received:', finalized.amount);
} else {
  await coco.ops.receive.cancel(prepared.id, 'User cancelled receive');
}
```

## Repeated Tokens and Failed Execution

Keep the operation ID while a receive is in progress and use `get()` or
`refresh()` to resume it. Calling `prepare({ token })` again creates another
receive attempt, even if an earlier attempt for those proofs finalized. It can
allocate new deterministic outputs before execution discovers that the input
proofs are already spent. Preparation validates the token and plans the receive;
it is not a guarantee that the mint will accept those proofs.

For a definitively spent token, execution rejects and may already have persisted
`rolled_back`. This does not credit the balance again. A network failure can
instead leave `executing` because the remote outcome is ambiguous; preserve that
operation and use recovery. An app may deduplicate repeated submissions in its UI,
but that is not a replacement for mint validation or operation recovery.

Do not unconditionally cancel in an execution catch block. Cancellation accepts
only `init` and `prepared`, and rejects an already rolled-back operation:

```ts
const prepared = await coco.ops.receive.prepare({ token });
try {
  await coco.ops.receive.execute(prepared.id);
} catch (error) {
  const current = await coco.ops.receive.get(prepared.id);
  if (current?.state === 'init' || current?.state === 'prepared') {
    // This example abandons an attempt that has not started remote execution.
    await coco.ops.receive.cancel(current.id, 'Receive abandoned after error');
  } else if (current?.state === 'executing') {
    // Retain the ID for recovery; the mint may already have accepted the swap.
    console.log('Receive needs recovery:', current.id);
  } else {
    console.log('Receive state:', current?.state);
  }
  console.error('Receive failed:', error instanceof Error ? error.message : error);
}
```

State can change between `get()` and `cancel()` when another session is active;
handle a rejected cancellation by reloading again. Never replace an ambiguous
in-flight receive with a new attempt just because execution threw.

## Recovery

`initializeCoco()` runs receive recovery automatically. Recovery removes stale
`init` operations, leaves `prepared` operations for user decision, and tries to
complete or roll back `executing` operations based on mint state.

Use `refresh(operationId)` for explicit recovery UI:

```ts
const operation = await coco.ops.receive.refresh(operationId);

if (operation.state === 'finalized') {
  console.log('Receive completed');
}

if (operation.state === 'rolled_back') {
  console.log('Receive rolled back:', operation.error);
}
```

## Events

```ts
coco.on('receive-op:prepared', ({ operationId, operation }) => {
  console.log('Receive prepared', operationId, operation.amount);
});

coco.on('receive-op:finalized', ({ operationId, operation }) => {
  console.log('Receive finalized', operationId, operation.amount);
});

coco.on('receive-op:rolled-back', ({ operationId, operation }) => {
  console.log('Receive rolled back', operationId, operation.error);
});
```
