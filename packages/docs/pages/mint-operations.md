# Mint Operations

Mint operations track quote-backed issuance from operation preparation through
proof redemption. They are durable so apps can wait for remote payment, recover
after crashes, and avoid losing issued proofs.

Bare quote creation is durable quote state, not a value movement. It does not
create history; history starts when an operation exists.

## API Surface (`coco.ops.mint`)

The operation lifecycle API is exposed through `coco.ops.mint`:

- `prepare({ mintUrl, method, quoteId, unit?, methodData?, amount? })` prepares
  a pending mint operation from an existing canonical quote. Reusable onchain
  quotes require `amount` because one quote can fund multiple operations.
- `execute(operationOrId)` redeems a paid quote and returns the terminal state
- `checkPayment(operationId)` checks the remote quote state for a pending
  operation
- `refresh(operationId)` checks or recovers an operation and returns the latest
  stored state
- `finalize(operationId)` executes or recovers the operation until it reaches a
  terminal state when possible
- `get(operationId)`, `getByQuote({ mintUrl, method, quoteId })`, `listPending()`, and
  `listInFlight()` load persisted operation state. Use `operationId` for local
  operation identity; a `quoteId` is remote quote identity and can be shared by
  more than one local operation.

Built-in mint methods are `bolt11`, `onchain`, and `bolt12`. Quote lookups use
the full `{ mintUrl, method, quoteId }` identity so reused quote IDs remain
scoped by method.

## Quote Resurfacing (`coco.quotes.mint`)

Use `coco.quotes.mint` when an app needs to show a quote payment request again
after reload without creating or loading a mint operation:

- `create({ mintUrl, amount, unit?, method })` creates and persists a canonical
  quote row only
- `import({ mintUrl, method, quote })` imports an existing remote quote snapshot
  into canonical quote storage only
- `get({ mintUrl, quoteId })` loads a canonical quote by quote identity
- `listPending({ method? })` lists canonical quote rows that have not reached
  `ISSUED`
- `refresh({ mintUrl, quoteId })` checks the remote quote state and
  persists the canonical quote update before emitting `mint-quote:updated`

`mint-quote:updated` is emitted when a quote is created/imported or remote
settlement state changes. Stable metadata-only updates do not emit. Importing a
quote can therefore start watcher interest, but it does not create history or a
mint operation; call `coco.ops.mint.prepare(...)` when you want to redeem it.

For BOLT11 quotes, the invoice is available at `quote.request`. For reusable
onchain quotes, the address/payment request is also available at `quote.request`
and claimable balance is derived from `quote.quoteData.amountPaid -
quote.quoteData.amountIssued`.

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
| `prepare(...)`              | canonical quote                                         | `pending`                                       | You are ready to track a quote as a mint operation.            |
| `checkPayment(operationId)` | `pending`                                               | latest remote observation; may queue redemption | You want to update UI after the invoice may have been paid.    |
| `execute(operationOrId)`    | `pending`                                               | `finalized` or `failed`                         | You know the quote is payable and want to redeem it now.       |
| `refresh(operationId)`      | any, actively checks `pending` and recovers `executing` | latest stored state                             | You are showing stale persisted state or a recovery screen.    |
| `finalize(operationId)`     | `pending`, `executing`, or terminal                     | terminal state when possible                    | You want one explicit call to settle or recover the operation. |

With the default mint watcher and processor enabled, apps usually do not need to
poll `refresh()` in the happy path. BOLT11 mint quotes and reusable onchain mint
quotes are watched automatically by WebSocket when available and by polling as a
fallback. Show the payment request from the pending operation, then render the
latest operation state from events, hook state, or a targeted `checkPayment()`
action.

## Prepare -> Pay -> Finalize Flow

```ts
const quote = await coco.quotes.mint.create({
  mintUrl,
  amount: 100,
  method: 'bolt11',
});

const pending = await coco.ops.mint.prepare({
  quote,
  amount: 100,
});

showInvoice(pending.request);

const check = await coco.ops.mint.checkPayment(pending.id);

if (check.category === 'ready' || check.category === 'completed') {
  const terminal = await coco.ops.mint.finalize(pending.id);
  console.log('Mint operation state:', terminal.state);
}
```

## Reusable Quotes

Onchain and BOLT12 mint quotes are canonical quote records first. Create and
refresh them through `coco.quotes.mint`, then prepare one or more mint
operations against the same `{ mintUrl, quoteId }` identity.

```ts
const quote = await coco.quotes.mint.create({
  mintUrl,
  method: 'onchain',
  unit: 'sat',
});

showAddress(quote.request);

const refreshed = await coco.quotes.mint.refresh({
  mintUrl,
  quoteId: quote.quoteId,
});

const claimable = refreshed.quoteData.amountPaid.subtract(refreshed.quoteData.amountIssued);
```

To mint part of the available balance explicitly, prepare an operation with the
amount to withdraw from the reusable quote.

```ts
const first = await coco.ops.mint.prepare({
  quote,
  amount: 25,
});

const second = await coco.ops.mint.prepare({
  quote,
  amount: 10,
});

await coco.ops.mint.finalize(first.id);
await coco.ops.mint.finalize(second.id);
```

BOLT12 uses the same quote-first flow. A fixed amount on a BOLT12 quote is
encoded into the reusable offer and constrains each payer payment, but it does
not constrain the later mint operation amount. Always pass the amount you want
to mint from the currently claimable quote balance.

```ts
const quote = await coco.quotes.mint.create({
  mintUrl,
  method: 'bolt12',
  unit: 'sat',
  amount: { amount: 100, unit: 'sat' },
  description: 'Coffee refill',
});

showOffer(quote.request);

const pending = await coco.ops.mint.prepare({
  quote,
  amount: 10,
});
```

When the mint watcher and processor are enabled, reusable quotes continue to be
watched after one claim finalizes so later deposits to the same reusable quote
can be detected. Funded reusable quotes are claimed automatically. If existing
pending operations do not consume all currently claimable balance, Coco creates
one additional mint operation for the remainder.

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
