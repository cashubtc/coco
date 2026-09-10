# Shared mint and melt lifecycle

Read for BOLT11, BOLT12, or onchain flows, together with the selected method's reference. These
rules cover every method; method files supply request shapes and method-specific decisions.

## Capabilities and identity

Check the selected mint's capability for the direction, method, and unit before offering a payment.
Use `coco.mint.checkPaymentMethodCapability({ mintUrl, operation, method, unit })`, where `operation`
is `'mint'` or `'melt'`; inspect `supported`, `reason`, and any amount limits. Use
`listPaymentMethodCapabilities({ mintUrl, operation, unit })` when building a method selector.
A mint supporting one direction or method need not support another.

Create canonical quotes with `coco.quotes.mint.create()` or `coco.quotes.melt.create()`, then pass
the quote to the matching operation's `prepare()`. Quote lookups and refresh take
`{ mintUrl, quoteId }`. Keep the operation ID separately for its execution, history, and recovery.

## Mint completion

A Mint Operation claims value from a quote into local proofs. Default background services observe
payments and advance mint operations. Render success from `mint-op:finalized` or a persisted
`finalized` operation; handle `mint-op:failed` for a terminal operation failure. A quote payment
observation alone does not establish that local proofs were saved.

Use `ops.mint.checkPayment(id)` for an explicit payment check on a pending operation and
`ops.mint.refresh(id)` to reconcile its current state. Follow the main skill's event subscription
and interruption rules, including loading current state when opening a resume screen.

Mint Quote expiry is a deadline for initiating payments, not proof that already paid value is
unclaimable. Continue reconciling paid work through Coco.

## Reusable quote claims

BOLT12 and onchain mint quotes can receive multiple payments and support multiple Mint Operations.
Use `amountPaid` and `amountIssued` for cumulative quote accounting; these quotes have no BOLT11
`state` field. Their difference is remote accounting, not necessarily locally claimable value:
Coco also accounts for finalized operations and active reservations.

With the default `processors.mintOperationProcessor.autoClaimMintQuotes: true`, Coco creates
claims for available quote value automatically. After a payment, discover the associated operations
with `ops.mint.listByQuote({ mintUrl, quoteId })` and track their operation events. Keep the quote
available for later payments after an individual operation finalizes.

If the app must choose each claim amount, set
`processors.mintOperationProcessor.autoClaimMintQuotes: false` in the session config before
starting that flow. This disables automatic claim creation; keep the watchers and processor
running to observe quotes and advance operations the app prepares. After the user selects an
amount in the quote's unit:

```ts
const quote = await coco.quotes.mint.refresh({ mintUrl, quoteId });
const pendingMint = await coco.ops.mint.prepare({ quote, amount: claimAmount });
const result = await coco.ops.mint.execute(pendingMint.id);
```

`claimAmount` is a positive `AmountLike` in the stored quote's unit. Coco evaluates claimability
when executing; a stale UI calculation cannot authorize issuance. An operation can remain pending
while insufficient unreserved value is available. Resume that operation rather than preparing a
replacement for every quote update. Choose one claim policy for the flow so automatic claims and
app-controlled partial claims do not compete for the same value.

## Melt review and settlement

Melt preparation reserves proofs. Before execution, show the destination, `prepared.amount`,
`prepared.unit`, `prepared.fee_reserve`, and `prepared.swap_fee`. Call `ops.melt.cancel(id)` when
the user abandons a prepared payment.

`ops.melt.execute(id)` may return `pending` or `finalized`. Subscribe before executing to
`melt-op:finalized` and `melt-op:rolled-back`, filtered by that operation ID, and handle an immediate
finalized return too. Default background services settle pending melts. Use `ops.melt.refresh(id)`
for explicit checks; let Coco's state-aware refresh/reclaim APIs determine whether pending funds
can be released. Display `effectiveFee` and `changeAmount` on finalized operations when present.

**Done when:** unsupported capabilities have a visible outcome, quote identity and operation IDs
are used correctly, and both immediate and delayed settlement resolve the original operation.
