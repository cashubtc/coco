# Batch Minting Plan V2

## Context

The original batch minting plan preserved Coco's existing invariant that every prepared mint
operation already owns the deterministic `outputData` for its own quote amount. That design is
crash-safe and can reduce HTTP requests, but it misses the main NUT-29 benefit: a batch can create
one optimized output split for the total amount across many quotes.

Example:

- Three independent 23 sat mints produce `16, 4, 2, 1` each, for 12 proofs total.
- One 69 sat batch can produce `64, 4, 1`, for 3 proofs total.

That optimization is only possible if output data is created after Coco chooses a concrete
redemption path. At quote creation time, Coco does not know whether a paid quote will be redeemed
alone or as part of a larger batch.

CDK's NUT-29 implementation follows this model:

- quote records stay per quote
- the batch issue saga owns the combined premint secrets / blinded messages
- the batch request uses outputs for the total amount
- each quote is marked issued for its own expected amount
- proofs are stored as outputs of the batch, not as proofs owned by individual quote records
- recovery replays the batch request first, then falls back to `/restore` using persisted batch output
  data

For Coco, the equivalent design is a persisted `MintBatchAttempt` that owns consolidated output data.

## Design Goal

Implement NUT-29 in a way that gets both benefits:

- one mint request for multiple paid quotes
- fewer proofs through an optimized denomination split for the combined amount

The design must preserve Coco's crash-safety boundary:

- after blinded messages may have been submitted to the mint, their output data must be durable
- recovery must never create a different output set for the same maybe-submitted request
- ambiguous network failures must not cause unrecoverable proof loss or double finalization

## Revised Mental Model

### Quote operations are not output owners

`MintOperation` should continue to represent one mint quote lifecycle:

- quote creation/import
- quote amount, unit, method, expiry, request
- remote state observations
- whether the quote has been locally redeemed/finalized

Mint operations should not own final mint `outputData` at quote prepare time. The operation should
carry enough quote metadata to schedule and validate redemption. Output data should be created only
after Coco knows which redemption path is being used:

- single finalization creates one output set for that quote amount
- batch finalization creates one output set for the combined batch amount

### Batch attempts own optimized outputs

A `MintBatchAttempt` represents one concrete redemption attempt for a group of quotes:

- the selected operation ids and quote ids
- the per-quote amounts used in the batch request
- the total amount
- the optimized consolidated output data
- the active keyset and counter range used to produce those outputs
- state for write-ahead recovery

This mirrors CDK's issue saga shape: once the batch exists, the batch owns the premint secrets.

## Data Model

### MintOperation changes

Adjust pending mint operations so `outputData` is no longer mandatory. In the normal new flow,
`pending` means "quote known, waiting to be redeemed", not "outputs already prepared".

Recommended shape:

```ts
interface PendingData {
  outputData?: SerializedOutputData;
  batchEligible?: boolean;
  redeemedByBatchId?: string;
}
```

Rules:

- Quote prepare should not create final mint `outputData` for either single or batch-capable methods.
- Single-operation finalization creates and stores `outputData` immediately before submitting the
  single quote mint request.
- Batch finalization creates and stores consolidated output data on `MintBatchAttempt`.
- `batchEligible` remains only a scheduling hint.
- `redeemedByBatchId` is set when a batch attempt has claimed or finalized the operation.
- Existing persisted operations with `outputData` remain valid and should still finalize through the
  single path or the old compatibility path if needed.

The single path does not need a separate `MintSingleAttempt` entity in the first slice. The
operation can continue to be the write-ahead record for single redemption, as long as the service
persists `outputData` on the operation before transitioning to `executing` and before calling the
mint. Batches need their own entity because one output set belongs to multiple operations.

### MintBatchAttempt

Add a new persisted entity in core and all adapters.

Suggested type:

```ts
export type MintBatchAttemptState =
  | 'prepared'
  | 'requesting'
  | 'finalized'
  | 'recovering'
  | 'failed';

export interface MintBatchAttempt {
  id: string;
  mintUrl: string;
  method: MintMethod;
  unit: string;
  operationIds: string[];
  quoteIds: string[];
  quoteAmounts: Amount[];
  totalAmount: Amount;
  outputData: SerializedOutputData;
  keysetId: string;
  counterStart?: number;
  counterEnd?: number;
  state: MintBatchAttemptState;
  error?: string;
  createdAt: number;
  updatedAt: number;
  requestedAt?: number;
  finalizedAt?: number;
}
```

Notes:

- `outputData` is the durable replay/recovery boundary.
- `quoteAmounts` are required even for bolt11 so recovery can reconstruct the exact request and so
  each operation can be finalized for its own contribution.
- `operationIds` and `quoteIds` are kept in the same order as `quoteAmounts`.
- `keysetId` should be a single active keyset for the first implementation. Mixed-keyset output sets
  can wait.
- `counterStart`/`counterEnd` are useful for deterministic recovery if the repo wants CDK-style
  counter-range re-derivation. If Coco's serialized `outputData` is sufficient for restore, these can
  be optional but still valuable for audits and migration.

### Repository surface

Add `MintBatchAttemptRepository`:

```ts
export interface MintBatchAttemptRepository {
  create(attempt: MintBatchAttempt): Promise<void>;
  update(attempt: MintBatchAttempt): Promise<void>;
  getById(id: string): Promise<MintBatchAttempt | null>;
  getByState(state: MintBatchAttemptState): Promise<MintBatchAttempt[]>;
  getByOperationId(operationId: string): Promise<MintBatchAttempt | null>;
  getPending(): Promise<MintBatchAttempt[]>;
  delete(id: string): Promise<void>;
}
```

Implement it in:

- memory repositories
- sqlite3
- sqlite-bun
- expo-sqlite
- indexeddb

Adapters should serialize `Amount` and `SerializedOutputData` consistently with existing operation
repositories.

## Handler Contract

Keep the method-handler boundary, but split quote preparation from output preparation. Quote
preparation gets the operation to `pending`; single or batch finalization creates the actual blinded
messages and persists them before the mint request is submitted.

Suggested additions:

```ts
export interface BatchSupportContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: PendingMintOperation<M>;
  wallet: Wallet;
}

export interface SingleOutputPrepareContext<M extends MintMethod = MintMethod>
  extends BaseHandlerDeps {
  operation: PendingMintOperation<M>;
  wallet: Wallet;
}

export interface BatchPrepareContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operations: PendingMintOperation<M>[];
  totalAmount: Amount;
  quoteAmounts: Amount[];
  wallet: Wallet;
}

export interface BatchExecuteContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  attempt: MintBatchAttempt;
  operations: PendingMintOperation<M>[];
  wallet: Wallet;
}

export interface MintMethodHandler<M extends MintMethod = MintMethod> {
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  prepareSingleOutput?(ctx: SingleOutputPrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  assessBatchSupport?(ctx: BatchSupportContext<M>): Promise<MintBatchSupport> | MintBatchSupport;
  prepareBatch?(ctx: BatchPrepareContext<M>): Promise<MintBatchAttempt>;
  executeBatch?(ctx: BatchExecuteContext<M>): Promise<MintBatchExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintCheckResult<M>>;
}
```

`prepareSingleOutput` creates the output data for one pending operation and returns an updated
operation ready to persist. It must not submit the mint request.

`prepareBatch` creates the consolidated output data and returns an attempt object ready to persist.
It must not submit the mint request.

The service, not the handler, persists the returned operation or attempt and owns state
transitions. That keeps the single and batch paths aligned:

- single: prepare output data, persist it on the operation, mark operation `executing`, call mint
- batch: prepare output data, persist it on the attempt, mark attempt `requesting`, call mint

## Flow: Quote Creation

1. `MintOperationService.init()` creates an `init` operation.
2. `MintOperationService.prepare()` calls `handler.prepare(...)`.
3. For bolt11, `handler.prepare(...)` creates or imports the quote and persists quote metadata.
4. The handler does not create final mint `outputData`.
5. The service asks `handler.assessBatchSupport(...)`.
6. The service persists `batchEligible`.
7. The operation enters `pending`.

This makes single and batch redemption structurally similar: quote preparation records the payment
claim, while finalization creates the blinded messages after the concrete redemption path is known.

## Flow: Scheduling

`MintOperationProcessor` still schedules based on paid quote events, but it now has two paths.

### Single path

Use the existing single finalize path when:

- the item is not batch eligible
- the mint lacks usable NUT-29 support
- only one ready operation is available and the processor chooses not to wait
- group validation says the operation must be downgraded

Single finalization should mirror batch write-ahead behavior:

1. Acquire the operation lock and reload the pending operation.
2. Revalidate trusted mint, quote state, method, and unit.
3. If the operation has no `outputData`, ask the handler to create single-operation output data for
   the operation amount.
4. Persist the operation with that `outputData`.
5. Transition the operation to `executing` before submitting the mint request.
6. Submit the single mint request using the persisted output data.
7. On success, save proofs and finalize as today.

If the process crashes after step 5, recovery uses the persisted operation output data. It must not
create a fresh output set for the same maybe-submitted single quote request.

### Batch path

When a ready batchable item is selected:

1. Ask `MintService` for current NUT-29 capability and effective max batch size.
2. Select ready queue items with same `mintUrl`, `method`, and `batchEligible === true`.
3. Cap by `max_batch_size`.
4. Call `MintOperationService.finalizeBatch(operationIds)`.

The processor remains method agnostic. It groups by scheduling criteria only. All protocol checks and
output creation happen in the service/handler.

The processor must also close the existing active-item dedupe gap. Returning an operation to
`pending` emits `mint-op:pending`; retryable result handling must not duplicate that queue entry.

## Flow: Batch Finalization

`MintOperationService.finalizeBatch(operationIds)` is the correctness boundary.

### Phase 1: lock and reload

1. Sort operation ids deterministically.
2. Acquire operation locks in sorted order.
3. Acquire the mint-scoped lock for the mint.
4. Reload every operation while locks are held.
5. Validate:
   - every operation is `pending`
   - every operation has `batchEligible === true`
   - same mint, method, and unit
   - trusted mint
   - last observed remote state is `PAID`
   - no operation is already claimed by another batch

### Phase 2: capability and quote validation

1. Load NUT-29 capability from `MintService`.
2. Enforce effective max batch size.
3. Run the NUT-29 quote-check endpoint for the concrete quote ids.
4. Require every response to correspond to the requested quote and to be mintable.
5. Compute per-quote amounts from the refreshed quote snapshots.
6. Reject or downgrade operation-local structural issues.
7. For mint capability absence, max-size overflow, or group-shape problems, return scheduling
   fallback results without mutating `batchEligible`.

### Phase 3: create and persist batch attempt

1. Ask the handler to prepare the batch.
2. Handler creates consolidated output data for `sum(quoteAmounts)`.
3. Service persists `MintBatchAttempt` in `prepared` state.
4. Service marks each operation as claimed by `redeemedByBatchId`.
5. Emit a batch prepared/internal event if useful.

At this point no mint request has been submitted. If the process crashes here, recovery can release
the operation claims or retry the prepared attempt.

### Phase 4: write-ahead transition

Before the network call:

1. Update the attempt to `requesting`.
2. Set `requestedAt`.
3. Persist the attempt.

This is write-ahead logging. After this state is durable, recovery must assume the mint may have
received the request.

### Phase 5: execute batch

1. Call `handler.executeBatch({ attempt, operations, wallet })`.
2. For bolt11, reconstruct the NUT-29 request from attempt data:
   - `quotes`
   - `quote_amounts`
   - consolidated `outputs`
   - no NUT-20 signatures in the first slice
3. Submit `/v1/mint/{method}/batch`.
4. Validate returned signatures and construct proofs using the attempt output data.

### Phase 6: persist success atomically where possible

On success:

1. Save all returned proofs as ready proofs with metadata:
   - set `createdByBatchId` to the finalized batch attempt id
   - leave `createdByOperationId` unset for batch-created proofs
2. Mark the batch attempt `finalized`.
3. Mark each mint operation `finalized`.
4. Set each operation's `lastObservedRemoteState` to `ISSUED`.
5. Preserve per-operation history with its quote amount.
6. Add a batch-level history/transaction entry if the history model supports it.
7. Emit `mint-op:finalized` per operation and a batch finalized event if added.

Proofs should not be split or assigned by operation amount. A 64 sat proof in a 69 sat batch belongs
to the batch output set, not to one 23 sat quote.

## Bolt11 Handler Details

### `assessBatchSupport`

Return `supported: true` when:

- method is bolt11
- quote is unlocked
- unit is supported
- quote amount is known and positive

For the first slice, locked quotes are explicitly unsupported and should be downgraded to the single
path. Do not add NUT-20 signing to the batch implementation yet.

### `prepareBatch`

For a group of pending bolt11 operations:

1. Validate same unit and method.
2. Compute `quoteAmounts` from operation amounts.
3. Compute `totalAmount`.
4. Use `ProofService.createOutputsAndIncrementCounters(mintUrl, { keep: totalAmount, send: 0 })`.
5. Serialize output data as `{ keep, send: [] }`.
6. Ensure the output total equals `totalAmount`.
7. Derive/store one keyset id from the created outputs.
8. Return a `MintBatchAttempt` draft.

This is where denomination optimization happens.

### `executeBatch`

1. Deserialize `attempt.outputData`.
2. Use `outputData.keep` as consolidated custom outputs.
3. Build entries from operations/attempt:

```ts
const entries = operations.map((operation, index) => ({
  amount: attempt.quoteAmounts[index],
  quote: {
    quote: operation.quoteId,
    ...(operation.pubkey ? { pubkey: operation.pubkey } : {}),
  },
}));
```

4. Call:

```ts
const preview = await wallet.prepareBatchMint(
  'bolt11',
  entries,
  { keysetId: attempt.keysetId },
  {
    type: 'custom',
    data: outputData.keep,
  },
);
const proofs = await wallet.completeBatchMint(preview);
```

5. Return the complete proof set for the batch.

The result should be batch-level, not `proofsByOperationId`.

Suggested result:

```ts
export type MintBatchExecutionResult =
  | { status: 'ISSUED'; proofs: Proof[] }
  | { status: 'ALREADY_ISSUED' }
  | { status: 'FAILED'; error?: string; retryable?: boolean };
```

## Recovery

Recovery should be state-driven from `MintBatchAttempt`.

### `prepared`

No request was submitted.

Recovery may:

- release operation claims and delete/fail the attempt
- or retry execution by moving to `requesting`

No proof recovery is needed because the mint should not have seen the output set.

### `requesting`

The request may have reached the mint.

Recovery must not create new output data.

Steps:

1. Check whether all expected output proofs are already saved.
2. If yes, finalize attempt and operations.
3. Reconstruct the original batch request from persisted attempt data.
4. Replay the request if the mint supports cached responses or idempotent behavior.
5. If replay succeeds, save proofs and finalize.
6. If replay fails with already-issued or ambiguous status, call `/restore` using persisted output
   data.
7. If restore recovers proofs, save and finalize.
8. If quote check says quotes remain `PAID` and no proofs are recoverable, return the attempt to a
   retryable state only if it is clear the original request was not accepted. Otherwise keep the
   attempt in a recoverable failed state and surface an error.

This is stricter than normal single retry. After `requesting`, blind messages may already have been
accepted by the mint; blindly creating a new attempt risks losing recoverability for the first output
set.

### `finalized`

No action except idempotent cleanup.

### `failed`

Keep enough data for manual or startup recovery unless the failure happened before the request was
submitted.

## Error Taxonomy

### Downgrade to single mint

Persist `batchEligible: false` only for operation-local structural problems:

- locked quote without a usable private key in the first implementation
- unsupported unit
- invalid quote metadata
- invalid or incompatible method-local data

### Scheduling fallback without mutating operation eligibility

Do not persist `batchEligible: false` for:

- mint lacks NUT-29
- group exceeds max batch size
- group shape is bad
- mixed keysets caused by the output strategy
- only one operation is ready

These are scheduler/capability issues, not operation-local facts.

### Retryable before request submission

If quote check or capability refresh fails before the attempt reaches `requesting`, return retryable
results and keep operations pending.

### Ambiguous after request submission

If the attempt is already `requesting`, recovery must use the persisted attempt and should prefer
replay/restore. Do not downgrade to single mint and do not create a new output set until recovery has
proved the old attempt was not accepted.

## Capability Parsing

Add a helper to `MintService`:

```ts
interface MintBatchCapability {
  supported: boolean;
  maxBatchSize: number;
}

getMintBatchCapability(mintUrl: string, method: MintMethod): Promise<MintBatchCapability>
```

Rules:

- `nuts[29]` absent or empty means unsupported.
- `max_batch_size` defaults to an internal cap, likely `100`.
- if `methods` is omitted, all NUT-04 mint methods are eligible.
- if `methods` is present, the requested method must be included.

Use this helper in both the processor and `finalizeBatch()`.

## MintAdapter

Add:

```ts
checkMintQuotesBatch(
  mintUrl: string,
  method: MintMethod,
  quoteIds: string[],
): Promise<MintQuoteBolt11Response[]>
```

It should call `POST /v1/mint/quote/{method}/check` through `MintRequestProvider` so auth,
rate-limiting, and error mapping stay consistent with other mint requests.

## History And Proof Metadata

The existing model often associates proofs with operation ids. Optimized batch proofs break that
one-to-one assumption.

Required first-slice changes:

- Add `createdByBatchId` to proof metadata.
- Keep `createdByOperationId` for single-operation mints.
- For batch-created proofs, set `createdByBatchId` and leave `createdByOperationId` unset.
- Per-operation history should record quote-level redemption amount.
- Batch history can record the actual proof set and total amount.

Do not ship the optimized batch path with ownerless batch proofs. Adding `createdByBatchId` in the
first implementation keeps proof ownership, history, audits, and recovery explicit.

## Migration And Compatibility

Existing pending mint operations may already have `outputData`.

Compatibility rules:

- If a pending operation has `outputData`, it can continue through the single path.
- Do not batch old operations with precomputed per-operation `outputData` in the optimized path.
  They are single-only for the first implementation.
- New operations should avoid precomputing output data, regardless of whether they later finalize
  through the single or batch path.
- Repository mappers must tolerate missing `outputData` for pending operations.

This is a breaking internal state-shape change and should be called out in migration notes if public
types expose `PendingMintOperation.outputData`.

## Implementation Steps

1. Add `MintBatchAttempt` core model and repository interface.
2. Implement batch attempt repositories in memory, sqlite3, sqlite-bun, expo-sqlite, and indexeddb.
3. Make pending mint `outputData` optional where needed, preserving single-operation compatibility.
4. Add required `createdByBatchId` proof metadata support.
5. Add NUT-29 capability parsing to `MintService`.
6. Add batch quote-check helper to `MintAdapter`.
7. Extend `MintMethodHandler` with single-output prepare, batch support, batch prepare, and batch
   execute hooks.
8. Change bolt11 prepare so it only prepares quote state and never creates final output data at
   quote prepare time.
9. Add single-finalize write-ahead output generation for pending operations without `outputData`.
10. Add `MintOperationService.finalizeBatch()`.
11. Add batch-attempt recovery on startup and when stale attempts are discovered.
12. Update `MintOperationProcessor` to group paid candidates and call `finalizeBatch()`.
13. Fix active queue dedupe before adding retryable batch result requeueing.
14. Add bolt11 `prepareBatch()` and `executeBatch()`.
15. Update history/proof ownership semantics.
16. Add docs explaining that optimized batch proofs are batch-owned, not quote-owned.

## Tests

### Model and repository tests

- pending mint operations can persist without `outputData`
- old pending operations with `outputData` still hydrate and remain single-only
- batch attempts persist and hydrate `Amount`, output data, quote amounts, ids, and state
- `getByOperationId()` finds the owning attempt
- adapter contract coverage across all storage adapters

### Capability tests

- missing `nuts[29]` is unsupported
- omitted `methods` allows bolt11 when NUT-29 exists
- explicit methods must include bolt11
- malformed or missing max size falls back to internal cap
- max size is enforced in processor and service

### Processor tests

- groups ready batchable same-mint/same-method operations
- does not group different mints, methods, or units
- falls back to single path when capability is unsupported
- caps group size
- dedupes pending events emitted during in-flight recovery/result handling
- downgraded operation is requeued as non-batchable
- retryable pre-request failure keeps operations batch eligible

### Service tests

- single finalization creates output data only during finalization
- single finalization persists output data before calling the mint
- single finalization transitions to `executing` only after output data has been persisted
- single recovery after `executing` reuses persisted output data and does not regenerate it
- `finalizeBatch()` reloads and validates operations under locks
- rejects stale/non-pending/claimed operations
- calls batch quote-check before creating outputs
- creates a batch attempt with output total equal to sum of quote amounts
- persists attempt before moving to `requesting`
- does not create new output data after `requesting`
- on success saves proofs and finalizes every operation
- on success saves batch proofs with `createdByBatchId` and no `createdByOperationId`
- batch proofs are not split by operation amount
- operation-local structural failure downgrades only that operation
- capability/group-shape failure does not mutate `batchEligible`

### Bolt11 handler tests

- `prepare()` creates/imports quote state but does not call output creation
- `prepareSingleOutput()` creates outputs for one quote amount
- `prepareBatch()` creates outputs for total amount, not per-quote amounts
- three 23 sat quotes produce a total 69 sat output target
- `executeBatch()` calls `prepareBatchMint('bolt11', ...)` with consolidated custom outputs
- NUT-20 signing is not attempted in the first slice
- locked quotes are rejected from batch support and downgraded to single mint

### Recovery tests

- `prepared` attempt can release claims without proof recovery
- `requesting` attempt replays using persisted outputs
- replay success saves proofs and finalizes operations
- replay failure falls back to restore
- restore success saves proofs and finalizes operations
- unresolved post-request attempt does not downgrade to single mint
- startup recovery handles stale batch attempts

## Recommended First Slice

Implement only optimized bolt11 batch minting for unlocked quotes:

- same mint
- same method `bolt11`
- same unit `sat`
- NUT-29 advertised
- one active keyset
- locked quotes rejected from batch support
- old pending operations with precomputed `outputData` treated as single-only
- batch-created proofs must be saved with `createdByBatchId`

This slice delivers the actual proof-count benefit while keeping the policy surface narrow.

## Superseded Parts Of The Original Plan

The following old-plan ideas should be replaced:

- Do not create final mint `outputData` during quote prepare, even for single mints.
- Do not reuse each operation's existing `outputData` for optimized batching.
- Do not return `proofsByOperationId`; optimized batch proofs are not attributable that way.
- Do not make `ensureOutputsSaved(operation, proofs)` the success path for batches. Add a
  batch-aware proof persistence path.
- Do not recover a post-request batch by trying single-operation minting.

The following old-plan ideas remain valid:

- keep the processor method agnostic
- keep `batchEligible` minimal
- parse NUT-29 capability in `MintService`
- use `MintAdapter` for batch quote check
- keep downgrade reasons out of persisted operation state
- process one compatible group per processor pass for fairness
