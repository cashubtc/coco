# Mint Operations

Mint operations track quote-backed issuance from operation preparation through
proof redemption. They are durable so apps can wait for remote payment, recover
after crashes, and avoid losing issued proofs.

Bare quote creation is durable quote state, not a value movement. It does not
create history; history starts when an operation exists.

## API Surface (`coco.ops.mint`)

The operation lifecycle API is exposed through `coco.ops.mint`:

- `prepare({ mintUrl, amount, unit?, method, methodData? })` creates a remote
  quote and persists a pending mint operation
- `importQuote({ mintUrl, quote, method, methodData? })` tracks an existing
  quote as a mint operation
- `execute(operationOrId)` redeems a paid quote and returns the terminal state
- `checkPayment(operationId)` checks the remote quote state for a pending
  operation
- `refresh(operationId)` checks or recovers an operation and returns the latest
  stored state
- `finalize(operationId)` executes or recovers the operation until it reaches a
  terminal state when possible
- `get(operationId)`, `getByQuote({ mintUrl, method, quoteId })`, `listPending()`, and
  `listInFlight()` load persisted operation state

## Quote Resurfacing (`coco.quotes.mint`)

Use `coco.quotes.mint` when an app needs to show a quote payment request again
after reload without creating or loading a mint operation:

- `create({ mintUrl, amount, unit?, method })` creates and persists a canonical
  quote row only
- `get({ mintUrl, method, quoteId })` loads a canonical quote by full identity
- `listPending({ method? })` lists canonical quote rows that have not reached
  `ISSUED`
- `refresh({ mintUrl, method, quoteId })` checks the remote quote state and
  persists the canonical quote update before emitting `mint-quote:updated`

For BOLT11 quotes, the invoice is available at `quote.request`. Future onchain
address/payment request support should use this same canonical quote surface.

## Operation States

Mint operations progress through the following states:

| State       | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| `init`      | Local mint intent exists before a quote snapshot is attached                   |
| `pending`   | Quote and deterministic output data are persisted; payment may settle remotely |
| `executing` | Quote redemption or recovery is in progress                                    |
| `finalized` | Quote was issued and proofs were saved or recovered                            |
| `failed`    | Quote reached a terminal non-issued state, such as expiry                      |

```
init -> pending -> executing -> finalized
          ^          |
          +----------+-> failed
```

## Lifecycle Actions

| Action                      | Valid input state                                       | Resulting state                                 | Use when                                                       |
| --------------------------- | ------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `prepare(...)`              | none                                                    | `pending`                                       | You need a new quote and invoice request to show the payer.    |
| `importQuote(...)`          | none                                                    | `pending`                                       | You already have a remote quote and want Coco to track it.     |
| `checkPayment(operationId)` | `pending`                                               | latest remote observation; may queue redemption | You want to update UI after the invoice may have been paid.    |
| `execute(operationOrId)`    | `pending`                                               | `finalized` or `failed`                         | You know the quote is payable and want to redeem it now.       |
| `refresh(operationId)`      | any, actively checks `pending` and recovers `executing` | latest stored state                             | You are showing stale persisted state or a recovery screen.    |
| `finalize(operationId)`     | `pending`, `executing`, or terminal                     | terminal state when possible                    | You want one explicit call to settle or recover the operation. |

With the default mint watcher and processor enabled, apps usually do not need to
poll `refresh()` in the happy path. Show the payment request from the pending
operation, then render the latest operation state from events, hook state, or a
targeted `checkPayment()` action.

## Prepare -> Pay -> Finalize Flow

```ts
const pending = await coco.ops.mint.prepare({
  mintUrl,
  amount: 100,
  method: 'bolt11',
});

showInvoice(pending.request);

const check = await coco.ops.mint.checkPayment(pending.id);

if (check.category === 'ready' || check.category === 'completed') {
  const terminal = await coco.ops.mint.finalize(pending.id);
  console.log('Mint operation state:', terminal.state);
}
```

## Recovery

`initializeCoco()` runs mint recovery automatically. Pending operations are
rechecked for trusted mints, and executing operations are recovered by checking
whether deterministic outputs were saved or can be restored.

Use `refresh(operationId)` when a screen is opened with an old operation id:

```ts
const operation = await coco.ops.mint.refresh(operationId);

if (operation.state === 'finalized') {
  console.log('Mint complete');
}

if (operation.state === 'failed') {
  console.log('Mint failed:', operation.terminalFailure?.reason ?? operation.error);
}
```

## Events

```ts
coco.on('mint-op:pending', ({ operationId, operation }) => {
  console.log('Mint pending', operationId, operation.request);
});

coco.on('mint-quote:updated', ({ quoteId, quote }) => {
  console.log('Quote updated', quoteId, quote.state);
});

coco.on('mint-op:executing', ({ operationId }) => {
  console.log('Mint executing', operationId);
});

coco.on('mint-op:finalized', ({ operationId, operation }) => {
  console.log('Mint terminal', operationId, operation.state);
});
```
