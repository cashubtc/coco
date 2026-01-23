# Melt Operations

Melt operations pay Lightning invoices by "melting" proofs at the mint. The flow is implemented as a saga so proofs are reserved safely, fees are clear before paying, and recovery is possible if the app crashes mid-payment.

## Overview

The melt operation saga provides:

- **Crash Recovery**: Operations can be recovered on startup
- **Proof Safety**: Proofs are reserved before any mint interaction
- **Fee Transparency**: Fee reserve and swap fee are known up front
- **Pending Tracking**: Pending melts can be checked and finalized later

## API Surface (Quotes API)

The public API is exposed through `coco.quotes`:

- `prepareMeltBolt11(mintUrl, invoice)` creates a melt quote and prepares the operation
- `executeMelt(operationId)` executes the prepared operation
- `executeMeltByQuote(mintUrl, quoteId)` resumes execution using a quote id
- `checkPendingMelt(operationId)` checks a pending melt and finalizes or rolls back
- `checkPendingMeltByQuote(mintUrl, quoteId)` checks a pending melt using a quote id

## Operation States

Melt operations progress through the following states:

| State          | Description                                            |
| -------------- | ------------------------------------------------------ |
| `init`         | Operation created, nothing reserved yet                |
| `prepared`     | Proofs reserved, fees calculated, ready to execute     |
| `executing`    | Swap/melt in progress                                  |
| `pending`      | Melt started, waiting for quote to settle              |
| `finalized`    | Melt succeeded, change claimed, operation finalized    |
| `rolling_back` | Rollback in progress (reclaim swap being executed)     |
| `rolled_back`  | Operation cancelled, proofs reclaimed                  |

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

Preparation creates the quote and reserves proofs before any funds move:

```ts
const prepared = await coco.quotes.prepareMeltBolt11(mintUrl, invoice);

console.log('Quote:', prepared.quoteId);
console.log('Amount:', prepared.amount);
console.log('Fee reserve:', prepared.fee_reserve);
console.log('Swap fee:', prepared.swap_fee);
console.log('Needs swap:', prepared.needsSwap);
```

Internally, the service:

1. Creates a melt quote at the mint
2. Selects proofs to cover the quote amount + fee reserve
3. Determines if a pre-swap is needed (`needsSwap`)
4. Reserves the input proofs and builds change outputs

### Execute

Execution moves the operation to `executing` before contacting the mint. It then:

1. Runs a swap if exact proofs are needed
2. Sends the melt request to the mint
3. Updates the operation based on the mint response

```ts
const result = await coco.quotes.executeMelt(prepared.id);

if (result.state === 'finalized') {
  console.log('Invoice paid');
}

if (result.state === 'pending') {
  console.log('Invoice pending');
}
```

If the mint returns `PAID`, the operation is finalized immediately. If the mint returns `PENDING`, the operation moves to `pending` and must be checked later.

## Handling Pending Operations

Pending operations should be checked until they finalize or roll back:

```ts
const decision = await coco.quotes.checkPendingMelt(operationId);

if (decision === 'finalize') {
  console.log('Melt finalized');
} else if (decision === 'rollback') {
  console.log('Melt rolled back');
}
```

`checkPendingMelt` queries the mint for the quote state and decides whether to finalize, stay pending, or rollback.

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
  console.log('Melt finalized');
});

coco.on('melt-op:rolled-back', ({ operationId, operation }) => {
  console.log('Melt rolled back');
});
```

## Implementation Notes

- Method-specific behavior (bolt11, bolt12, onchain) is delegated to `MeltMethodHandler`
- Operations are locked per id; concurrent calls throw `OperationInProgressError`
