# Receive Operations

Receive operations turn an encoded Cashu token into proofs stored in the local
wallet. The operation API makes receiving explicit so apps can review decoded
token details, recover after crashes, and avoid duplicate receives.

## API Surface (`coco.ops.receive`)

The canonical API is exposed through `coco.ops.receive`:

- `prepare({ token })` decodes and validates a token, calculates fees, and
  creates deterministic receive outputs
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
