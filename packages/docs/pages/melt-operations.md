# Melt Operations

Melt operations pay Lightning invoices by "melting" proofs at the mint. The flow is implemented as a saga so proofs are reserved safely, fees are clear before paying, and recovery is possible if the app crashes mid-payment.

## Overview

The melt operation saga provides:

- **Crash Recovery**: Operations can be recovered on startup
- **Proof Safety**: Proofs are reserved before any mint interaction
- **Fee Transparency**: Fee reserve and swap fee are known up front
- **Pending Tracking**: Pending melts can be checked and finalized later

## API Surface (`coco.ops.melt`)

The canonical API is exposed through `coco.ops.melt`:

- `prepare({ quote })` prepares a BOLT11 or BOLT12 operation from a canonical melt quote or quote ref
- `prepare({ quote, feeIndex })` prepares an onchain melt from a canonical NUT-30 quote or quote ref
- `execute(operationOrId)` executes the prepared operation
- `getByQuote({ mintUrl, method, quoteId })` resolves an operation from a persisted quote id
- `refresh(operationId)` checks a pending melt and returns the latest operation state
- `cancel(operationId)` cancels a prepared melt
- `reclaim(operationId)` reclaims a pending melt when rollback is allowed

Create and resurface quote payment requests through `coco.quotes.melt` before
preparing a melt operation:

- `create({ mintUrl, method: 'bolt11', methodData: { invoice }, unit? })` creates and persists a canonical quote row only
- `create({ mintUrl, method: 'bolt12', methodData: { offer, amountSats }, unit? })` creates and persists a canonical quote row only
- `create({ mintUrl, method: 'onchain', methodData: { address, amountSats }, unit? })` creates and persists a canonical quote row with `fee_options`
- `get({ mintUrl, quoteId })` loads a canonical quote by quote identity
- `listPending({ method? })` lists canonical quote rows that have not reached `PAID`
- `refresh({ mintUrl, quoteId })` checks the remote quote state and persists
  the canonical quote update

## Operation States

Melt operations progress through the following states:

| State          | Description                                         |
| -------------- | --------------------------------------------------- |
| `init`         | Operation created, nothing reserved yet             |
| `prepared`     | Proofs reserved, fees calculated, ready to execute  |
| `executing`    | Swap/melt in progress                               |
| `pending`      | Melt started, waiting for quote to settle           |
| `finalized`    | Melt succeeded, change claimed, operation finalized |
| `rolling_back` | Rollback in progress (reclaim swap being executed)  |
| `rolled_back`  | Operation cancelled, proofs reclaimed               |

```
init ──► prepared ──► executing ──► pending ──► finalized
  │         │            │            │
  │         │            └────────────┴──────────────► finalized
  │         │            │            │
  │         │            │            └──► rolling_back ──► rolled_back
  │         │            │                      │
  └─────────┴────────────┴──────────────────────┴──► rolled_back
```

## Prepare → Execute Flow

### Prepare

Quote creation is separate from operation preparation. Create the quote first,
then prepare the operation once the user is ready to reserve proofs:

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});

const prepared = await coco.ops.melt.prepare({
  quote,
});

console.log('Quote:', prepared.quoteId);
console.log('Amount:', prepared.amount);
console.log('Fee reserve:', prepared.fee_reserve);
console.log('Swap fee:', prepared.swap_fee);
console.log('Needs swap:', prepared.needsSwap);
```

For BOLT12 offers:

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'bolt12',
  methodData: { offer, amountSats: 1000 },
});

const prepared = await coco.ops.melt.prepare({
  quote,
});
```

For onchain addresses, choose one advertised fee option by its `fee_index`:

```ts
const quote = await coco.quotes.melt.create({
  mintUrl,
  method: 'onchain',
  methodData: { address, amountSats: 21_000 },
});

const prepared = await coco.ops.melt.prepare({
  quote,
  feeIndex: quote.fee_options[0].fee_index,
});
```

Pass one of the advertised `quote.fee_options[].fee_index` values. The selected
fee option's `fee_reserve` is copied onto the prepared operation for proof
selection; the selected `feeIndex` is operation data, not quote data.

Internally, the service:

1. Loads the canonical quote row
2. Selects proofs to cover the quote amount + fee reserve
3. Determines if a pre-swap is needed (`needsSwap`)
4. Reserves the input proofs and builds change outputs

### Execute

Execution moves the operation to `executing` before contacting the mint. It then:

1. Runs a swap if exact proofs are needed
2. Sends the melt request to the mint
3. Updates the operation based on the mint response

```ts
const result = await coco.ops.melt.execute(prepared.id);

if (result.state === 'finalized') {
  console.log('Invoice paid');
  console.log('Change returned:', result.changeAmount);
  console.log('Effective fee:', result.effectiveFee);
}

if (result.state === 'pending') {
  console.log('Invoice pending');
}
```

If the mint returns `PAID`, the operation is finalized immediately. If the mint returns `PENDING`, the operation moves to `pending` and must be checked later. Onchain melts are generally asynchronous, but intramint melt/mint settlement can also return `PAID` immediately, sometimes without an outpoint.

## Handling Pending Operations

Pending operations should be checked until they finalize or roll back:

```ts
const operation = await coco.ops.melt.refresh(operationId);

if (operation.state === 'finalized') {
  console.log('Melt finalized');
} else if (operation.state === 'rolled_back') {
  console.log('Melt rolled back');
}
```

`refresh` queries the mint for the quote state when the operation is pending, performs any needed finalize or rollback work, and returns the latest stored operation. Refresh the operation, not only the quote, when you need local proof state and change proofs to advance.

The operation returned by `refresh()` already includes settlement details when the melt has finalized:

```ts
const operation = await coco.ops.melt.refresh(operationId);

if (operation.state === 'finalized') {
  console.log('Change returned:', operation.changeAmount);
  console.log('Effective fee:', operation.effectiveFee);
}
```

`changeAmount` and `effectiveFee` are recorded for newly finalized melt operations. Older finalized melt records created before settlement tracking was added may not have those values.

## Rollback Behavior

Rollbacks reclaim proofs when an operation is cancelled or fails:

- Prepared operations can be rolled back immediately
- Pending operations are only rolled back if the quote is confirmed `UNPAID`
- Rolling back a pending melt uses a reclaim swap, so the final amount may be reduced by fees

## Crash Recovery

On startup, the melt service recovers operations automatically:

- `init` operations are cleaned up and deleted
- `prepared` operations are left for user decision
- `executing` operations are recovered based on mint status
- `pending` operations are checked and finalized or kept pending
- `rolling_back` operations log a warning (manual intervention may be needed)

## Events

```ts
coco.on('melt-op:prepared', ({ operationId, operation }) => {
  console.log('Prepared melt', operation.amount);
});

coco.on('melt-op:pending', ({ operationId, operation }) => {
  console.log('Melt pending', operation.quoteId);
});

coco.on('melt-op:finalized', ({ operationId, operation }) => {
  console.log('Melt finalized', operation.changeAmount, operation.effectiveFee);
});

coco.on('melt-op:rolled-back', ({ operationId, operation }) => {
  console.log('Melt rolled back');
});
```

## Implementation Notes

- Built-in `manager.ops.melt` support covers `bolt11`, `bolt12`, and `onchain`
- Operations are locked per id; concurrent calls throw `OperationInProgressError`
