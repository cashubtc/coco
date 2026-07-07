# Receive Operations

Receive operations turn an encoded Cashu token into proofs stored in the local
wallet. The operation API makes receiving explicit so apps can review decoded
token details, recover after crashes, and avoid duplicate receives.

## API Surface (`coco.ops.receive`)

The canonical API is exposed through `coco.ops.receive`:

- `prepare({ token })` decodes and validates a token, calculates fees, and
  creates deterministic receive outputs; returns a `deferred` operation instead
  when the receive cannot be settled yet
- `execute(operationOrId)` receives the prepared token and saves the new proofs
- `get(operationId)` returns a persisted receive operation
- `listPrepared()` lists receives waiting for user confirmation
- `listDeferred()` lists receives queued for later redemption
- `redeemDeferred(filter?)` attempts to redeem queued receives now, batched per
  mint and unit
- `listInFlight()` lists receives that may need recovery (executing or deferred)
- `refresh(operationId)` recovers an executing receive and returns the latest
  operation state
- `cancel(operationId, reason?)` rolls back an `init`, `prepared`, or `deferred`
  receive

## Operation States

Receive operations progress through the following states:

| State         | Description                                                                             |
| ------------- | --------------------------------------------------------------------------------------- |
| `init`        | Token decoded and validated, but outputs are not prepared yet                           |
| `prepared`    | Fees calculated, output data persisted, ready to execute                                |
| `executing`   | Receive request is in progress at the mint                                              |
| `deferred`    | Redemption postponed until it can be settled fee-efficiently or its prerequisites exist |
| `finalized`   | New proofs were saved locally                                                           |
| `rolled_back` | Operation was cancelled or could not be recovered                                       |

```
init -> prepared -> executing -> finalized
  |        |             |
  |        |             +-> deferred (batch member returned to queue)
  |        |             |
  +--------+-------------+-> rolled_back
  |
  +-> deferred -> executing (batch redemption)
```

## Lifecycle Actions

| Action                         | Valid input state                  | Resulting state                            | Use when                                                                 |
| ------------------------------ | ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `prepare({ token })`           | none                               | `prepared` or `deferred`                   | You want to inspect token amount, mint, unit, and fees before receiving. |
| `execute(operationOrId)`       | `prepared`                         | `finalized`                                | The user confirmed the receive and proofs should be saved.               |
| `redeemDeferred(filter?)`      | `deferred`                         | `finalized` per redeemed member            | Connectivity returned or the user asks to retry queued receives.         |
| `refresh(operationId)`         | any, actively recovers `executing` | latest stored state                        | You are resuming an operation after a crash or stale UI state.           |
| `cancel(operationId, reason?)` | `init`, `prepared`, `deferred`     | `rolled_back` or deleted when not prepared | The user abandons the receive before it completes.                       |

## Prepare -> Execute Flow

```ts
const prepared = await coco.ops.receive.prepare({ token });

if (prepared.state === 'deferred') {
  console.log('Receive queued:', prepared.deferredReason);
} else {
  console.log('Amount:', prepared.amount);
  console.log('Mint:', prepared.mintUrl);
  console.log('Fee:', prepared.fee);

  if (userConfirmed) {
    const finalized = await coco.ops.receive.execute(prepared.id);
    console.log('Received:', finalized.amount);
  } else {
    await coco.ops.receive.cancel(prepared.id, 'User cancelled receive');
  }
}
```

## Deferred Receives

Some tokens cannot be settled at the moment they arrive. Instead of failing,
coco queues them as `deferred` operations with a `deferredReason`:

- `dust` — the token's value does not cover the swap fee on its own
  (NUT-02: `fee = ceil(sum(input_fee_ppk) / 1000)`, so a lone 1-sat proof at
  100 ppk would leave zero outputs)
- `mint-unreachable` — mint or keyset data could not be fetched (e.g. offline)

### Batch Redemption

Deferred receives are redeemed in batches per mint and unit. A batch settles
with **one** swap whose single fee is apportioned across the members
(largest first), so dust that could never pay its own fee rides along with
larger receives. Every member still finalizes as its own operation with its
own `receive-op:finalized` event and history entry.

Redemption is attempted automatically:

1. when a new receive arrives for the same mint and unit — the incoming token
   drains the queue by batching with it (this is how queued dust becomes
   redeemable),
2. at the end of the receive recovery sweep (`initializeCoco()` startup and
   `coco.ops.receive.recovery.run()`), and
3. explicitly via `coco.ops.receive.redeemDeferred()`.

Groups whose combined value stays at or below the combined fee remain queued.
A future configuration may additionally hold redemption until the fee ceiling
(`floor(1000 / input_fee_ppk)` inputs per fee unit) is better utilized.

> **Design note.** Issue [#46](https://github.com/cashubtc/coco/issues/46)
> sketched a separate `receive_later` table. Deferred receives are modeled as a
> state of the receive operation saga instead: the saga already provides
> durable persistence, crash recovery, locking, events, and the one-operation →
> one-history-entry projection that keeps batched redemptions independently
> auditable.

```ts
const queued = await coco.ops.receive.listDeferred();
console.log(
  'Queued:',
  queued.map((op) => `${op.amount} (${op.deferredReason})`),
);

// e.g. when connectivity returns:
await coco.ops.receive.redeemDeferred();
```

## Recovery

`initializeCoco()` runs receive recovery automatically. Recovery removes stale
`init` operations, leaves `prepared` operations for user decision, tries to
complete or roll back `executing` operations based on mint state, and finishes
by attempting to redeem queued `deferred` operations.

Interrupted batch redemptions recover as a group: when the batch inputs were
spent the members restore from their own output data, and when they were not
the combined swap is re-executed. A batch member is never re-executed alone
because its fee share only balances inside its batch.

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

coco.on('receive-op:deferred', ({ operationId, operation }) => {
  if (operation.state === 'deferred') {
    console.log('Receive queued', operationId, operation.deferredReason);
  }
});

coco.on('receive-op:finalized', ({ operationId, operation }) => {
  console.log('Receive finalized', operationId, operation.amount);
});

coco.on('receive-op:rolled-back', ({ operationId, operation }) => {
  console.log('Receive rolled back', operationId, operation.error);
});
```
