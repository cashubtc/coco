# Batch Minting Plan

## Context

`@cashu/cashu-ts@4.1.0` exposes NUT-29 batch minting through the wallet API:

- `wallet.prepareBatchMint(method, entries, config?, outputType?)`
- `wallet.completeBatchMint(batchPreview)`

The batch preview builds one request with multiple quote ids, per-quote amounts, and one
consolidated output set. `BatchMintRequest` contains:

- `quotes: string[]`
- `quote_amounts: bigint[]` (`cashu-ts` sends this even though NUT-29 makes it
  optional/null for methods that do not require explicit per-quote amounts)
- `outputs: SerializedBlindedMessage[]`
- optional NUT-20 quote signatures

NUT-29 adds two wallet-facing endpoints:

- `POST /v1/mint/quote/{method}/check` with `{ quotes: string[] }`, returning quote objects in the
  same order. Before minting, wallets SHOULD verify all quotes are paid.
- `POST /v1/mint/{method}/batch`, which requests blind signatures for one consolidated output set.

Both endpoints use all-or-nothing error handling. For the batch mint request, the mint must reject
the entire batch if the request is empty, contains duplicate/unknown/invalid quotes, mixes methods
or units, includes quotes that are not mintable, has a bad output/amount balance, or has invalid
NUT-20 signatures. Mint info can advertise `nuts[29].max_batch_size` and `nuts[29].methods`; when
`methods` is omitted, every NUT-04 mint method is eligible for batching.

Coco already prepares deterministic `outputData` per mint operation before the quote is paid.
That persisted output data is the replay-safety boundary we need to preserve.

## Current Coco Flow

The current mint path is intentionally method-oriented:

1. `MintOperationWatcherService` subscribes to pending quote updates. It already batches quote
   subscriptions by mint, but emits one `mint-op:quote-state-changed` event per quote.
2. `MintOperationProcessor` enqueues `PAID` operations and drains one queue item at a time.
3. The processor does not execute method-specific minting directly. Its default handler calls
   `MintOperationService.finalize(operationId)`.
4. `MintOperationService.finalize()` loads the operation, transitions `pending -> executing`,
   resolves the method handler from `operation.method`, and calls `handler.execute(...)`.
5. `MintBolt11Handler.execute()` deserializes the operation's existing output data and calls
   `wallet.mintProofsBolt11(...)` for one quote.

The important consequence is that batching should not be added as a bolt11 shortcut in
`MintOperationProcessor`. The processor only knows queue scheduling. Method-aware execution belongs
behind the `MintOperationService` / `MintMethodHandler` boundary.

## Goals

- Redeem multiple queued paid mint operations in one mint request when they share a mint and method.
- Keep the design method agnostic, so future mint methods can opt into batch execution without
  processor changes.
- Preserve the existing operation state machine, events, history updates, recovery behavior, and
  per-operation proof metadata.
- Reuse existing per-operation deterministic `outputData`; avoid a new batch-operation table or
  output-data migration for the first implementation.
- Fall back to single-operation execution when batching is unsupported, unsafe, or only one operation
  is ready.

## Non-Goals

- Batch quote creation. This plan only batches redemption of already-created, paid quotes.
- A new persisted "batch operation" aggregate. Each quote remains its own `MintOperation`.
- Solving locked NUT-20 mint quotes. Existing single execution does not currently carry a private
  key through mint operations, so locked quote batching should be explicitly skipped until that
  support exists.

## Proposed Design

### 1. Persist only a minimal batch eligibility flag

Add only a small scheduling hint to pending-or-later mint operations:

```ts
batchEligible?: boolean;
```

`batchEligible` should be determined when the operation becomes `pending`, not at `init`. `init`
does not yet have the quote snapshot, and eligibility should depend only on operation-local facts
such as quote fields and persisted output data. Mint-wide NUT-29 support and batch-size limits
belong to mint capability parsing, not operation state.

The service should compute this hint after `handler.prepare(...)` returns the pending operation. For
imported quotes, that still happens during `importQuote(...)->prepare(...)`, so imported paid quotes
get the same scheduling hint before they reach the processor.

This flag is a scheduler hint, not a correctness guarantee. It is mainly there to avoid repeatedly
trying obviously unbatchable operations, such as locked quotes before Coco has a stored signing-key
path. It should not store an unsupported reason or mint capability fields. `MintOperationService`
must still reload and revalidate every operation before executing a batch.

### 2. Extend the method handler contract

Add an optional batch capability to `MintMethodHandler`:

```ts
export interface MintBatchSupport {
  supported: boolean;
}

export interface BatchSupportContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: PendingMintOperation<M>;
  wallet: Wallet;
}

export interface BatchCapabilityContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operations: PendingMintOperation<M>[];
  wallet: Wallet;
}

export interface BatchExecuteContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operations: ExecutingMintOperation<M>[];
  wallet: Wallet;
}

export type MintBatchExecutionResult =
  | {
      status: 'ISSUED';
      proofsByOperationId: Map<string, Proof[]>;
    }
  | {
      status: 'FAILED';
      error?: string;
    };

export interface MintMethodHandler<M extends MintMethod = MintMethod> {
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  assessBatchSupport?(ctx: BatchSupportContext<M>): Promise<MintBatchSupport> | MintBatchSupport;
  executeBatch?(ctx: BatchExecuteContext<M>): Promise<MintBatchExecutionResult>;
  canBatch?(ctx: BatchCapabilityContext<M>): Promise<MintBatchSupport> | MintBatchSupport;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintCheckResult<M>>;
}
```

The exact type names can be adjusted, but the shape should stay per-operation. Even if a method's
batch endpoint is all-or-nothing, returning proofs by operation id lets the service keep the existing
proof metadata and finalization events.

`assessBatchSupport` and `canBatch` should be optional. If they are absent, the method does not batch.
This keeps third-party or future handlers compatible: they can keep implementing only `execute()`.

`assessBatchSupport` answers "should this individual pending operation be scheduled as batchable?"
`canBatch` answers "is this concrete group still safe to batch right now?" The second check exists
because persisted scheduling hints can become stale.

### 3. Add a service-level batch finalization API

Add a method on `MintOperationService`, for example:

```ts
async finalizeBatch(operationIds: string[]): Promise<MintBatchFinalizeResult>
```

Responsibilities:

- Acquire operation locks in a deterministic order, then reload every operation while the locks are
  held and validate that batchable candidates are:
  - `pending`
  - same `mintUrl`
  - same `method`
  - `operation.batchEligible === true`
  - trusted mint
  - observed as remotely ready, currently `lastObservedRemoteState === 'PAID'`
- Resolve the handler using the existing `handlerProvider.get(method)`.
- Load the current NUT-29 capability for `{ mintUrl, method }` from `MintService` and enforce its
  effective max batch size.
- Re-run the handler group-level `canBatch` check before state transitions.
- Run the NUT-29 batch quote check (`/v1/mint/quote/{method}/check`) for the concrete group when the
  mint advertises NUT-29 and require the response to be in request order with every quote mintable.
  If the check is unavailable or fails transiently, return retryable results without moving
  operations to `executing`.
- For operations that are no longer locally eligible for batching, persist `batchEligible: false`
  and return a `downgraded` result to the processor. Keep downgrade details in logs, not in persisted
  operation state or scheduler control flow. Mint-capability and group-shape failures should not
  mutate operation eligibility.
- Transition only the still-batchable group to `executing`, persist each operation, and emit
  `mint-op:executing` per operation.
- Use `handler.executeBatch(...)` when:
  - the handler implements it
  - there is more than one candidate
  - `canBatch` allows the group
- On batch success, save and verify proofs for each operation using the existing
  `ensureOutputsSaved(operation, proofs)` path, then call `finalizeIssuedOperation(...)` per
  operation.
- On batch failure, do not mark the whole group as failed. Use a batch-specific recovery path that
  checks saved outputs and remote issuance per operation before deciding how each operation should
  continue.
- For transient or ambiguous failures such as network errors, timeouts, rate limits, or unclear
  submission status, unresolved operations should return to `pending` with `batchEligible: true`.
  The normal pending event may re-enqueue paid quotes, so the processor must either use its own
  active-item dedupe when also handling retryable results, or make retryable result handling
  acknowledge that the pending event already owns requeueing. Do not let both paths add duplicate
  queue entries for the same operation.
- Only operation-local structural failures should downgrade an operation to single-mint execution.
  Group-shape failures such as mixed output keysets, mint capability absence, or batch-size limits
  should fall back, split, shrink, or retry without permanently mutating per-operation eligibility.

Suggested result shape:

```ts
type MintBatchFinalizeItemResult =
  | { operationId: string; status: 'finalized'; operation: FinalizedMintOperation }
  | { operationId: string; status: 'failed'; operation: FailedMintOperation }
  | { operationId: string; status: 'downgraded' }
  | { operationId: string; status: 'retryable'; error: string };

interface MintBatchFinalizeResult {
  results: MintBatchFinalizeItemResult[];
}
```

Use `downgraded` when an item should leave the batch group and run through the single-operation path.
Use `retryable` for transient or ambiguous failures such as network errors, timeouts, rate limits, or
a batch request whose submission status is unclear. Retryable results keep the operation's current
`batchEligible` value. Because returning an operation to `pending` emits `mint-op:pending`, retryable
requeue handling must be deduplicated against that event path.

### 4. Keep processor batching method agnostic

Change `MintOperationProcessor` from "find one ready item" to "find ready items and process one
compatible group":

- Keep queue entries as
  `{ mintUrl, operationId, method, batchEligible, retryCount, nextRetryAt }`.
- Find all items where `nextRetryAt <= now`.
- Pick the next ready item.
- If it is not batchable, run the existing single-operation path for that one item.
- If it is batchable, ask `MintService` for the current effective NUT-29 limit for
  `{ mintUrl, method }`, then select matching ready items from the queue with:
  - same `mintUrl`
  - same `method`
  - `batchEligible === true`
  - within the effective NUT-29 max batch size
- Call `mintOperations.finalizeBatch(operationIds)` only for that batchable group.
- Apply result handling per operation:
  - `finalized` / `failed`: remove from queue
  - `downgraded`: requeue with `batchEligible: false` so it is processed singly on a later turn
  - `retryable`: apply existing retry/backoff with the existing `batchEligible` value, but dedupe
    against any `mint-op:pending` event emitted while the batch was recovering
  - group fallback/split: retry a smaller compatible group or requeue without persisting
    `batchEligible: false` unless the service identified an operation-local structural issue

Before adding result-driven requeueing, fix the current queue dedupe TODO by tracking active
operation keys as well as queued keys, or route all result requeues through a helper that can collapse
duplicates created by recovery events.

The processor should not know whether `bolt11`, `bolt12`, or a future method has a native batch
endpoint. It only groups by method because cross-method batches are not valid.

Suggested new processor options:

```ts
export interface MintOperationProcessorOptions {
  processIntervalMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  initialEnqueueDelayMs?: number;
}
```

The default max batch size should come from the mint capability helper: use
`nuts[29].max_batch_size` when advertised, otherwise use a conservative internal cap such as `100`.

### 5. Implement bolt11 as the first batch-capable handler

`MintBolt11Handler.assessBatchSupport()` should set the persisted scheduling hint during prepare:

- `supported: true` when the quote is unlocked, the unit is supported, and the operation's output
  data can be used in a custom batch output set.
- `supported: false` when batching is structurally unsupported.

`MintBolt11Handler.canBatch()` should revalidate the concrete group before execution:

- same method and unit
- all operations still locally eligible for batching
- all quotes unlocked for the first implementation
- all custom outputs use a single keyset id that is present in the wallet
- total custom output amount equals the sum of the per-operation amounts
- group size within the advertised max
- mint still advertises NUT-29 support for `bolt11`; an omitted `nuts[29].methods` list means all
  NUT-04 methods, including `bolt11`, are supported

`MintBolt11Handler.executeBatch()` can then reuse existing per-operation output data:

1. Deserialize each operation's `outputData`.
2. Take each operation's `keep` outputs. Mint operations currently prepare only keep outputs.
3. Concatenate all outputs in operation order.
4. Derive the single `keysetId` from those outputs and fall back if the group uses mixed keysets.
   NUT-29 itself can carry ids per blinded message, but `cashu-ts` 4.1.0
   `completeBatchMint()` unblinds the preview with one `keysetId`, so the first implementation should
   not batch mixed-keyset operation output data.
5. Build batch entries:

```ts
const entries = operations.map((operation) => ({
  amount: operation.amount,
  quote: {
    quote: operation.quoteId,
    ...(operation.pubkey ? { pubkey: operation.pubkey } : {}),
  },
}));
```

6. Call:

```ts
const preview = await wallet.prepareBatchMint(
  'bolt11',
  entries,
  { keysetId },
  {
    type: 'custom',
    data: allOutputs,
  },
);
const proofs = await wallet.completeBatchMint(preview);
```

7. Split returned proofs back by each operation's output count and return
   `proofsByOperationId`.

This preserves the deterministic output data Coco already persisted. `cashu-ts` validates that custom
output total equals the batch amount, and `completeBatchMint()` validates returned signatures against
the consolidated output data.

Bolt11 should mark operations locally ineligible when:

- the operation has `pubkey` until Coco has a clear locked-quote private-key path
- operations use units other than `sat` if broader unit support is not implemented yet

The batch attempt should fall back or retry without mutating operation eligibility when:

- the mint does not advertise NUT-29 support for `bolt11`
- the operation group uses mixed output keysets
- the group exceeds the mint's advertised `nuts[29].max_batch_size`
- the mint returns a structural batch-size error such as `BATCH_SIZE_EXCEEDED`; retry with a smaller
  group if possible before falling back to single-operation processing
- the batch request fails due to network, timeout, rate limit, or ambiguous submission status

Bolt11 should not downgrade for transient request failures.

### 6. Recovery semantics

The current crash-safe sequence is:

`pending -> executing -> save proofs -> finalized`

Batch execution should keep the same sequence per operation:

- All candidates move to `executing` before the batch mint request.
- If the request succeeds and proofs are returned, each operation persists only the proofs generated
  from its own output data.
- If proof persistence fails for one operation after the batch succeeded, recovery should use the
  existing `recoverProofsFromOutputData()` path for that operation.
- If the batch request errors, each executing operation should be recovered individually:
  - saved outputs already present -> finalize
  - remote quote is `ISSUED` -> recover proofs from persisted output data and finalize if recovered
  - remote quote is still `PAID`/`UNPAID` or the quote check cannot complete because the mint is
    offline -> transition back to `pending`
- For non-structural failures, operations that return to `pending` keep `batchEligible: true`. The
  normal `mint-op:pending` flow may re-enqueue paid quotes, and the processor should form another
  batch on a later pass after deduping that event path against retryable result handling.
- For operation-local structural failures, persist `batchEligible: false` and requeue that operation
  for single minting. Group-shape failures should not poison per-operation eligibility.
- Retrying after a lost batch response is safe because recovery checks saved outputs and remote
  issuance before another mint attempt.

## Refined Flow

1. An operation is prepared.
2. The service asks the method handler to assess batch support and persists the resulting
   `batchEligible` hint on the pending operation.
3. The regular flow continues until the quote is paid and the operation is queued in
   `MintOperationProcessor`.
4. On schedule, the processor picks the next ready queue item.
5. If the item is not batchable, the processor runs the existing single-operation finalize path.
6. If the item is batchable, the processor selects matching ready batchable items from the queue and
   hands that group to `MintOperationService.finalizeBatch(...)`.
7. The service reloads the operations, revalidates the group, and hands only still-batchable operations
   to the method handler's batch execution path.
8. If one or more operations are no longer structurally batchable, the service persists
   `batchEligible: false` and returns `downgraded` results.
9. The processor requeues downgraded operations as non-batchable so they are picked up singly in a
   later turn.
10. Transient batch failures move unresolved operations back to `pending` with `batchEligible: true`;
    pending-event and retryable-result requeue paths are deduped, then the processor batches them
    again on a later pass.

## Resolved Design Choices

1. **Batch metadata shape**: keep operation metadata minimal: `operation.batchEligible` only.
   Do not persist unsupported reasons or mint capability details on each operation.
2. **Downgrade taxonomy**: persist `batchEligible: false` only for operation-local
   incompatibilities: unsupported method, locked quote without stored signing key, mixed unit, or
   invalid persisted output data. Treat missing NUT-29 support, mixed output keyset groups, and
   batch-size incompatibility as scheduling fallbacks. Treat network errors, timeouts, rate limits,
   and ambiguous submissions as retryable; unresolved operations keep `batchEligible: true` and are
   re-enqueued for a later batch attempt.
3. **NUT-29 capability source**: add a small helper in `MintService` (or a nearby utility) that parses
   the stored mint info consistently. It should treat omitted `nuts[29].methods` as "all NUT-04
   methods" and expose an effective max batch size from `nuts[29].max_batch_size` or an internal
   default. `MintOperationProcessor` should use this helper when choosing group size, and
   `MintOperationService.finalizeBatch()` should revalidate it before execution. If a mint lacks
   NUT-29 support, the processor should take the existing single-operation path without changing
   operation eligibility.
4. **NUT-29 quote checking**: add a `MintAdapter` helper for
   `POST /v1/mint/quote/{method}/check` until `cashu-ts` exposes one directly. Use the shared
   `MintRequestProvider` so rate limiting and protocol error handling stay consistent.
5. **Locked quotes**: skip any `pubkey` quote for batching in the first slice. Add NUT-20 signing only
   after mint operation method data has an explicit private-key path.
6. **Queue fairness**: process one compatible group per pass. This matches the current timer model and
   avoids long processor monopolization when many quotes become paid at once.
7. **Retry requeue ownership**: returning an executing operation to `pending` emits `mint-op:pending`.
   The implementation must dedupe that event against retryable result handling, for example with an
   active queue key set. Otherwise a batch recovery can enqueue the same operation twice.

## Implementation Steps

1. Add the persisted flat batch eligibility hint to
   `packages/core/operations/mint/MintOperation.ts` and every adapter repository that serializes mint
   operations.
2. Add batch support and batch execution types to
   `packages/core/operations/mint/MintMethodHandler.ts`.
3. Add NUT-29 capability and batch quote-check helpers in `MintService` / `MintAdapter`.
4. During `MintOperationService.prepare()`, call the handler's batch-support assessment after the
   pending operation is produced and persist the resulting `batchEligible` hint.
5. Add `MintOperationService.finalizeBatch()` and private helpers for:
   - loading and validating batch candidates
   - acquiring and releasing multiple operation locks in deterministic order
   - loading current NUT-29 max batch size from `MintService`
   - running the NUT-29 batch quote check before `executing`
   - downgrading stale locally ineligible operations
   - transitioning a group to `executing`
   - finalizing per-operation batch results
   - recovering a failed batch group and re-enqueueing unresolved transient failures as
     batch-eligible
6. Update `MintOperationProcessor` to queue `batchEligible`, read NUT-29 max batch size from
   `MintService`, select matching batchable items, and requeue downgraded operations as
   non-batchable. As part of this change, close the existing active-item dedupe gap so requeue events
   emitted during in-flight processing cannot duplicate retryable result requeues.
7. Implement `assessBatchSupport`, `canBatch`, and `executeBatch` in `MintBolt11Handler`.
8. Add focused unit tests:
   - prepare persists `batchEligible: true` for locally eligible bolt11 operations
   - prepare persists `batchEligible: false` for locked or otherwise locally ineligible bolt11
     operations
   - capability parsing treats omitted `nuts[29].methods` as allowing `bolt11`
   - processor falls back to single-operation execution when mint capability lacks NUT-29 support
     without mutating operation eligibility
   - processor caps group size using `MintService` NUT-29 max batch size instead of operation fields
   - service uses the NUT-29 batch quote-check endpoint before moving the group to `executing`
   - processor drains a ready same-mint/same-method group in one service call
   - processor processes non-batchable ready items singly
   - processor keeps different mints/methods in separate groups
   - processor requeues downgraded operations as non-batchable
   - service transitions all candidates to `executing` before batch execution
   - service downgrades stale locally ineligible candidates without executing them singly
   - service saves/finalizes each operation with only its own proofs
   - network batch failure recovers/requeues unresolved operations with `batchEligible: true`
   - processor dedupes retryable result handling against `mint-op:pending` requeue events
   - a later processor pass forms another batch for still-eligible requeued operations
   - operation-local structural failures requeue with `batchEligible: false`
   - bolt11 handler uses `prepareBatchMint('bolt11', ...)` with custom output data and the derived
     `keysetId`
   - bolt11 handler splits returned proofs by operation output counts
   - bolt11 skips batching when NUT-29 is not advertised or a quote has `pubkey`
   - bolt11 falls back for mixed-keyset groups without persisting operation-local ineligibility
   - batch-size errors split or fall back without failing operations
9. Run:
   - `bun run --filter='@cashu/coco-core' test -- test/unit/MintQuoteProcessor.test.ts`
   - `bun run --filter='@cashu/coco-core' test -- test/unit/MintOperationService.test.ts`
   - `bun run --filter='@cashu/coco-core' test -- test/unit/MintBolt11Handler.test.ts`
   - `bun run --filter='@cashu/coco-core' typecheck`

## Recommended First Slice

Keep the first implementation narrow:

- Add the generic batch handler contract.
- Persist `batchEligible` on pending mint operations.
- Add NUT-29 capability parsing and batch quote checking.
- Add service-level batch finalization.
- Teach the processor to group ready items by mint and method.
- Implement bolt11 batching only for unlocked paid quotes on NUT-29-capable mints when the persisted
  outputs share a keyset.
- Fall back to existing single-operation behavior for every unsupported case.

This gives the desired win for multiple queued paid bolt11 quotes while preserving the handler-based
architecture and leaving custom methods free to opt in later.
