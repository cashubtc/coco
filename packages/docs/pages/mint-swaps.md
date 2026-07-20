# Mint Swaps

Mint swaps move an exact `sat` amount from one trusted mint to another through a locked BOLT11
invoice. Coco treats the workflow as one durable parent operation. The owned source melt and
destination mint operations are implementation details and are hidden from grouped history.

## Requirements

Both mint URLs must be different after normalization and explicitly trusted. The source must
support BOLT11 melts plus NUT-07 and NUT-09 recovery. The destination must support BOLT11 minting,
NUT-09 recovery, and NUT-20 locked quotes. NUT-08 is optional; without it Coco uses a conservative
maximum source debit.

Mint swaps are exact-receive and `sat`-only in this release. They do not provide exchange-rate
conversion, multi-source payment, or same-mint routing.

## Prepare, review, and execute

```ts
import { Amount } from '@cashu/coco-core';

const prepared = await coco.ops.mintSwap.prepare({
  sourceMintUrl: 'https://source.example',
  destinationMintUrl: 'https://destination.example',
  amount: Amount.from(10_000),
});

console.log({
  receive: prepared.destinationAmount.toString(),
  minimumDebit: prepared.preparedPlan?.minimumSourceDebit.toString(),
  maximumDebit: prepared.preparedPlan?.maximumSourceDebit.toString(),
  dispatchDeadline: prepared.preparedPlan?.dispatchDeadline,
});

const current = await coco.ops.mintSwap.execute(prepared);
const terminal = await coco.ops.mintSwap.waitFor(current.id, { timeoutMs: 120_000 });
```

`prepare()` reserves source value but never dispatches payment. Present the immutable minimum and
maximum source debit to the user before calling `execute()`. Execution rechecks trust,
capabilities, and the quote safety window before authorizing the source payment.

## How fees are calculated

The `amount` passed to `prepare()` is the **exact amount received at the destination**. It is not
the amount removed from the source. The source pays that amount plus the costs of selecting and
spending source proofs and paying the Lightning invoice.

Mint swaps keep the costs separate because they become known at different times:

| Field                  | What it pays for                                               | When it is known                                   |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `sourcePreparationFee` | NUT-02 input fee for an optional source-mint pre-swap          | Exact at preparation; zero for a direct melt       |
| `sourceMeltInputFee`   | NUT-02 input fee for proofs sent to the source melt endpoint   | Exact at preparation                               |
| `sourceFeeReserve`     | Maximum payment allowance requested by the source mint         | Exact quote value, but **not necessarily charged** |
| `sourcePaymentFee`     | Settled payment-side cost after subtracting the melt-input fee | Known after source settlement                      |
| `totalSourceFee`       | Preparation fee + melt-input fee + payment-side cost           | Known after source settlement                      |

When NUT-08 returns all unused value, `sourcePaymentFee` corresponds to the actual Lightning
routing cost. In degraded operation without that guarantee, it is intentionally broader: it may
also contain payment-side reserve or denomination value that the source mint did not return.

### Before execution: a range, not an estimate

The prepared plan exposes a lower and upper source debit:

```text
minimumSourceDebit
  = destinationAmount
  + sourcePreparationFee
  + sourceMeltInputFee
```

The minimum assumes a zero payment-side fee. Coco deliberately does not expose an “estimated fee”
because the source mint supplies a reserve ceiling, not a reliable routing-fee estimate.

For a direct melt where the source supports NUT-08 change:

```text
maximumSourceDebit = minimumSourceDebit + sourceFeeReserve
```

Without NUT-08, the mint is not guaranteed to return unused reserve or proof-denomination overage,
so a direct plan uses the conservative bound:

```text
maximumSourceDebit = reservedSourceAmount
```

If Coco first performs a source-mint pre-swap, excess value is separated into local
`sourceKeepAmount` proofs. The maximum is therefore the reserved value minus those keep proofs,
which is equivalent to the minimum plus the quoted reserve.

`reservedSourceAmount` can be greater than `maximumSourceDebit`. Reservation temporarily protects
the complete selected proof set from concurrent spending; it does not mean all of that value will
be consumed.

### After settlement: the actual debit

Unused source value can return in two places:

- `sourceKeepAmount`: value separated locally by the optional pre-swap;
- `sourceMeltChangeAmount`: change returned by the source melt, normally through NUT-08.

The final values must satisfy both views of the same debit:

```text
sourcePaymentFee = effectiveFee - sourceMeltInputFee

totalSourceFee
  = sourcePreparationFee
  + sourceMeltInputFee
  + sourcePaymentFee

sourceReturnedAmount = sourceKeepAmount + sourceMeltChangeAmount

finalSourceDebit
  = destinationAmount + totalSourceFee
  = reservedSourceAmount - sourceReturnedAmount
```

Coco completes the operation only when these equations agree, the debit does not exceed
`maximumSourceDebit`, and persisted destination proofs total exactly `destinationAmount`.

### Worked example

Suppose the destination must receive `1,000 sat`. The direct source plan reserves `1,024 sat`, has
a `2 sat` melt-input fee, and the source mint asks for a `20 sat` fee reserve:

```text
destinationAmount       = 1,000 sat
sourcePreparationFee    =     0 sat
sourceMeltInputFee      =     2 sat
sourceFeeReserve        =    20 sat
reservedSourceAmount    = 1,024 sat

minimumSourceDebit      = 1,000 + 0 + 2  = 1,002 sat
maximumSourceDebit      = 1,002 + 20     = 1,022 sat  (with NUT-08)
```

If the settled payment-side cost is `6 sat`, the source returns `16 sat` as melt change:

```text
totalSourceFee          = 0 + 2 + 6      =     8 sat
sourceReturnedAmount    = 0 + 16         =    16 sat
finalSourceDebit        = 1,000 + 8      = 1,008 sat
balance check           = 1,024 - 16     = 1,008 sat
```

Only `8 sat` was charged in total. The unused part of the `20 sat` reserve came back as change.
Without a NUT-08 guarantee, the preview would show the conservative `1,024 sat` maximum instead.

Applications can render the preview and final settlement directly:

```ts
const plan = prepared.preparedPlan;

console.log(plan?.sourcePreparationFee.toString());
console.log(plan?.sourceMeltInputFee.toString());
console.log(plan?.sourceFeeReserve.toString());
console.log(plan?.minimumSourceDebit.toString());
console.log(plan?.maximumSourceDebit.toString());

const completed = await coco.ops.mintSwap.waitFor(prepared.id);
console.log(completed.settlement?.totalSourceFee.toString());
console.log(completed.settlement?.finalSourceDebit.toString());
```

## Recovery and terminal states

`initializeCoco()` recovers child operations first, reconciles active mint swaps, starts the
durable mint-swap processor, then enables live watchers. Periodic repository sweeps mean WebSocket
events are an optimization rather than a correctness dependency.

- `completed`: destination proofs and exact final source accounting are committed.
- `cancelled`: cancellation was proven safe before destination funding.
- `failed`: a value-neutral terminal outcome was proven.
- `needs_attention`: canonical evidence conflicts or automatic repair would risk value.

Do not treat `source_inflight`, `destination_funded`, or `issuing` as failure. They are durable
recovery states. `retry()` requests immediate reconciliation; it does not create replacement
quotes, outputs, or child operations.

## Events and history

Subscribe through `coco.on('mint-swap-op:completed', handler)` and the other
`mint-swap-op:*` lifecycle events. Payloads contain the parent id, revision, state, normalized mint
URLs, amount, and a sanitized reason code. Proof secrets, invoices, signatures, keys, and quote ids
are not emitted.

History returns one `mint-swap` entry with both mint identities, preview bounds, final debit/fees,
and sanitized terminal detail. Parent-owned mint and melt rows are hidden by default.

## React

```tsx
import { useMintSwapOperation } from '@cashu/coco-react';

const swap = useMintSwapOperation();
await swap.prepare({ sourceMintUrl, destinationMintUrl, amount: 10_000 });
await swap.execute();
```

The hook follows only its bound parent, rejects stale revisions, exposes `needs_attention` as
operation state (not a hook exception), and removes listeners when unmounted.

## Processor configuration

The processor is enabled by default. Hosts can tune its durable sweep and retry cadence:

```ts
await initializeCoco({
  repo,
  seedGetter,
  processors: {
    mintSwapOperationProcessor: {
      sweepIntervalMs: 5_000,
      dueBatchSize: 50,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
    },
  },
});
```

Disabling the processor stops automatic reconciliation and outbox publication; explicit
`refresh()` and startup recovery remain available.
