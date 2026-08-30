# Transaction Design

Status: accepted ([ADR-0011](./packages/core/docs/adr/0011-use-domain-transaction-gateways.md))

## Purpose

Define one recognizable transaction seam for crash-safe and concurrency-resistant core workflows.
Repository-backed state changes in critical paths should be atomic without allowing repository
details, transaction lifecycle, or pre-commit events to leak through orchestration interfaces.

Uniformity means that code which depends on atomicity follows the same safe pattern. It does not
mean that every service, query, or operation must run in a transaction.

The design separates three kinds of work:

1. orchestration, including remote mint and wallet I/O;
2. informational queries that do not authorize mutations; and
3. authoritative reads and writes performed through transaction-scoped modules.

## Decision Summary

- The composition root owns one application-scoped `CoreTransactionRunner` and constructs the
  domain transaction gateways that use it.
- Orchestration modules receive narrow domain transaction gateways. They do not receive, create, or
  own the raw runner.
- The runner creates a short-lived `CoreTransaction` for each transaction.
- One runner invocation covers one atomic Wallet persistence boundary. Every transaction module
  exposed by that invocation uses the exact same repository transaction scope.
- Nested and distributed transactions are not supported. An adapter combination that cannot
  provide the required shared scope must not be constructible as a `CoreTransactionRunner`.
- Independent Coco Sessions using the same Wallet storage must not silently lose updates. An
  adapter may serialize conflicting work or reject it with a typed transaction conflict.
- The runner may retry only adapter-declared transient conflicts, using a small bounded policy.
- `CoreTransaction` exposes narrow, domain-oriented transaction modules rather than repositories.
- Repository interfaces are visible only to repository adapters, query implementations,
  transaction-module implementations, and the composition root.
- Remote I/O is structurally unavailable inside transaction modules.
- Transaction callbacks and dependencies must work within the strictest supported adapter's
  transaction lifecycle. IndexedDB is the portability baseline.
- Informational reads may happen outside a transaction, but any read authorizing a mutation must be
  repeated or validated inside the transaction.
- Live events are published only after commit. Durable event delivery through an outbox is a
  separate future feature.

The standard orchestration shape is:

```text
preflight -> authorize transaction -> remote I/O -> apply transaction -> publish
```

## Ownership and Lifetimes

```text
Composition root / Manager
  |-- Repositories
  |-- CoreQueries
  |-- CoreTransactionRunner
  |     `-- creates CoreTransaction per run()
  |           |-- tx.proofs
  |           |-- tx.keypairs
  |           |-- tx.sends
  |           |-- tx.receives
  |           |-- tx.mintOperations
  |           |-- tx.meltOperations
  |           `-- tx.mintSwaps
  |-- CoreTransactions
  |     |-- proofTransactions
  |     |-- keypairTransactions
  |     `-- mintSwapTransactions
  |-- ProofService
  |-- MintOperationService
  `-- MeltOperationService
```

The application-scoped modules live for one Coco Session:

- `CoreTransactionRunner`;
- domain transaction gateways such as `ProofTransactions`;
- query modules such as `ProofQueries`; and
- orchestration modules such as `ProofService` and `MeltOperationService`.

The runner creates transaction-scoped modules for one `run()` call. Callers must not retain a
`CoreTransaction` or any of its modules after the callback completes.

## Core Transaction Interface

```ts
export interface CoreTransaction {
  proofs: TransactionalProofOperations;
  keypairs: TransactionalKeypairOperations;
  sends: TransactionalSendOperations;
  receives: TransactionalReceiveOperations;
  mintOperations: TransactionalMintOperations;
  meltOperations: TransactionalMeltOperations;
  mintSwaps: TransactionalMintSwapOperations;
}

export interface CoreTransactionRunner {
  run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}
```

The repository-backed implementation owns transaction creation and module construction:

```ts
class RepositoryCoreTransactionRunner implements CoreTransactionRunner {
  constructor(
    private readonly repositories: Repositories,
    private readonly modules: TransactionModuleFactory,
  ) {}

  run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T> {
    return this.repositories.withTransaction(async (repositories) => {
      const transaction = this.modules.create(repositories);
      return command(transaction);
    });
  }
}
```

There is one construction path for transaction modules. Individual orchestration modules do not
implement their own `forTransaction()` factories.

`CoreTransactionRunner` is an internal mechanism, not an orchestration dependency. Application-
scoped transaction gateways provide the recognizable interface used by orchestration:

```ts
export interface ProofTransactions {
  reserveForSend(command: ReserveProofsCommand): Promise<ProofReservation>;
  allocateOutputs(command: AllocateOutputsCommand): Promise<PreparedOutputs>;
}

export interface MintSwapTransactions {
  prepareOwnedMelt(command: PrepareOwnedMeltCommand): Promise<PreparedOwnedMelt>;
}

export interface KeyringTransactions {
  generateP2pkKey(command: GenerateP2pkKeyCommand): Promise<Keypair>;
}
```

Their implementations invoke the shared runner and dispatch to the internal transaction module.
This prevents orchestration code from nesting transactions, composing unsafe primitive write
sequences, or performing arbitrary work inside a transaction callback.

## Concurrency and Retry Contract

The transaction contract covers independent Coco Sessions using the same Wallet storage, not only
calls through one runner instance. Adapters need not provide globally serializable execution across
processes, but contention must not silently overwrite committed state.

An adapter may satisfy this contract by serializing conflicting work or rejecting one participant
with a typed transaction conflict. The runner may apply a small bounded retry only to conflicts the
adapter explicitly marks transient. Stable IDs, timestamps, and other command inputs are fixed
before entering the retried callback, and transaction operations must be replay-safe. Exhausted
contention is returned as a typed error.

Authoritative write operations use the adapter's strong write transaction. SQLite adapters use
`BEGIN IMMEDIATE`; IndexedDB uses one read-write transaction. Adapter modes do not leak into domain
transaction gateways.

Nested use is prevented structurally. Orchestration receives gateways rather than the raw runner,
and transaction modules cannot depend on gateways or orchestration services. Architecture tests
enforce those dependency rules. Adapters may reject accidental nesting defensively, but the design
does not require an ambient cross-runtime async-context mechanism.

## Transaction Module Interfaces

Transaction modules expose domain operations, not generic repository mutation. Their interfaces
should make illegal state changes difficult to express.

A transaction operation should represent one atomic domain state transition: a sequential group of
local reads and writes whose invariants must succeed or fail together. When that transition crosses
multiple repository-backed concepts, prefer one deep operation that owns the complete write
sequence instead of requiring orchestration code to call several modules in the correct order.

The transaction operation belongs to the domain concept that owns the invariant, even when it
mutates records from several repositories. Repository count does not justify a neutral workflow
bucket. For example, preparing a Melt Operation owned by a Mint Swap belongs to
`transaction.mintSwaps` because the parent Mint Swap owns the complete transition.

For example, prefer:

```ts
await mintSwapTransactions.prepareOwnedMelt(command);
```

over exposing proof reservation, output allocation, child creation, and parent attachment as a
caller-managed sequence.

This rule stops at the remote-I/O boundary. A workflow containing remote I/O remains an
orchestration workflow split into separate atomic transitions. It must not be hidden inside one
transaction method or hold a repository transaction open across the remote call.

Code inside a transaction must remain portable to IndexedDB transaction semantics. The precise
allowed dependency contract is adapter-driven, but it cannot include work that may let the
underlying transaction become inactive before all reads and writes are scheduled.

Prefer:

```ts
interface TransactionalProofOperations {
  reserveForOperation(command: ReserveProofsCommand): Promise<ProofReservation>;
  allocateOutputs(command: AllocateOutputsCommand): Promise<PreparedOutputs>;
  authorizeSpend(reservation: ProofReservation): Promise<void>;
  settleSpend(command: SettleProofsCommand): Promise<void>;
  release(reservation: ProofReservation): Promise<void>;
}
```

Avoid exposing primitives that permit arbitrary transitions:

```ts
interface UnsafeProofWrites {
  setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void>;
  setCounter(mintUrl: string, keysetId: string, counter: number): Promise<void>;
}
```

Transaction implementations may use such repository primitives internally while enforcing proof
ownership, unit consistency, legal state transitions, and counter allocation.

## ProofService Example

`ProofService` becomes an orchestration module. It may coordinate queries, remote I/O,
transactions, logging, and post-commit publication, but it does not access repositories directly.

```ts
class ProofService {
  constructor(
    private readonly queries: ProofQueries,
    private readonly transactions: ProofTransactions,
    private readonly mint: MintPort,
    private readonly publisher: EventPublisher,
  ) {}
}
```

A standalone proof mutation still uses the shared runner:

```ts
async reserveForSend(command: ReserveProofsCommand): Promise<ProofReservation> {
  return this.transactions.reserveForSend(command);
}
```

A workflow spanning multiple domains delegates its complete atomic transition to the owning domain
gateway:

```ts
await mintSwapTransactions.prepareOwnedMelt(command);
```

Internally, that command reserves proofs, allocates counters, persists the child, and changes the
parent through one runner invocation. If any step fails, the complete transition rolls back.

## Counter Ownership

Counter allocation is part of deterministic proof-output creation. It should not remain a separate
orchestration interface that callers must coordinate with proof persistence.

`TransactionalProofOperations.allocateOutputs()` owns the invariant:

1. read the current counter;
2. derive deterministic outputs;
3. advance the counter by the number of allocated outputs; and
4. return the prepared output data.

The counter repository and any counter helper remain internal implementation details. A caller
cannot create outputs without advancing the counter or advance it without producing the associated
plan.

A counter position becomes allocated only when its transaction commits. Tentative output
derivation in a transaction that rolls back did not allocate the position and may be repeated.
Committed positions are never reclaimed, including when the owning operation later aborts or fails.

## Keypair Ownership and Allocation

Keypair derivation uses one internal allocation mechanism, but its domain transaction interfaces are
purpose-specific. P2PK key generation belongs to `KeyringTransactions`. A NUT-20 mint-quote key is
allocated internally by mint-quote orchestration; callers do not select a generic keypair purpose.

The Wallet Seed is loaded and converted into a synchronous, purpose-bound key deriver before an
IndexedDB-compatible transaction opens. Inside the transaction, the keypair operation:

1. reads the durable high-water mark for the purpose;
2. chooses the next derivation index;
3. derives the keypair synchronously; and
4. persists the keypair and high-water mark atomically.

A derivation index becomes allocated only when both values commit. A rolled-back derivation may be
repeated. A committed index is never reclaimed or reused, including after key deletion.

The application-scoped keyring gateway owns the asynchronous `SeedService` dependency. It passes
only the synchronous deriver into `transaction.keypairs.allocate()`. The scoped keyring repository
therefore includes keypair allocation and reuses the runner's active strong write transaction; it
does not start a nested root transaction. If seed loading fails, no transaction begins. A bounded
transaction retry may call the same deriver with a newly selected index.

Mint quote creation does not require a durable local creation intent before remote I/O. If Coco
creates a quote remotely but crashes before recording or exposing its identity, losing that quote is
acceptable because no caller could have acted on it. Its locally committed derivation index remains
used. Existing P2PK key deletion semantics remain unchanged and may be revisited separately.

## Proof Ownership and State Transitions

Proof transaction interfaces express legal transitions and operation ownership rather than
arbitrary state changes. The initial interface should cover commands equivalent to:

```ts
interface TransactionalProofOperations {
  selectAndReserve(intent: ProofSelectionIntent, operationId: string): Promise<ProofReservation>;
  markSubmitted(operationId: string, secrets: string[]): Promise<void>;
  settleSpent(operationId: string, secrets: string[]): Promise<void>;
  releaseAfterNonEffect(operationId: string, secrets: string[]): Promise<void>;
  saveCreated(operationId: string, proofs: CoreProof[]): Promise<void>;
}
```

Selection and reservation are one atomic operation over spendable, unowned proofs. Every later
transition verifies the expected current state and owning operation. Generic repository methods
such as `setProofState()` remain adapter implementation or migration primitives, not transaction
gateway operations.

## First Workflow Milestone

Send and core Receive validate the first transaction seam as separate vertical migrations. Their
public `prepare()` operations create durable operations directly in `prepared`; neither workflow
persists an intermediate `init` state that recovery only deletes.

Adapters and startup recovery retain deprecated read support for legacy persisted `init` operations.
New code does not create them. Their model types and recovery path remain until a later breaking
release removes the legacy state.

Send preflight loads dependencies that are unsafe to await inside an IndexedDB transaction. Its
prepare transaction selects and reserves owned proofs, allocates deterministic outputs when needed,
advances counters, and persists the exact prepared operation.

Receive preflight decodes the token and signs P2PK inputs with an existing Wallet key. The signed
input proofs become part of the immutable Exact Operation Request persisted by its prepare
transaction. Execution and Operation Recovery reuse those signatures and do not reload the key or
regenerate witnesses.

Coco does not create local claims for incoming token proofs. If two Wallets or Coco Sessions try to
receive the same proof, the mint accepts one request and rejects the later request because the proof
is already spent. An explicit rejection fails the later Receive Operation. A transport failure or
other ambiguous response leaves it executing for Operation Recovery.

Payment Request source metadata remains supported, but atomic parent, attempt, and child transitions
belong to the later Payment Request migration.

Send swaps and Receive use the same remote-effect shape. A `beginExecution` transaction reloads a
prepared operation, verifies its revision and owned local resources, and persists `executing` before
the mint request. An `applyResult` transaction reloads that durable state, applies the validated
result to proofs and the operation, and commits the complete local outcome atomically.

Exact-match Send has no remote effect and does not enter `executing`. One local transaction reloads
the prepared operation, verifies its reserved proofs, marks those proofs inflight, persists the
token, and moves the operation directly to `pending`. A crash cannot leave proof state and operation
state on opposite sides of that transition.

Transaction commands accept operation identities rather than operation objects. Each operation has
a monotonic revision used for conditional transitions. Concurrent commands cannot both advance the
same revision. In-memory operation and mint locks may remain temporarily to reduce contention but
are not correctness mechanisms.

The revision is read-only persistence and query metadata. Public commands do not accept an expected
revision from callers; gateways load and enforce it internally.

Operation repositories expose conditional transitions rather than blind updates:

```ts
transition({
  operationId,
  expectedState,
  expectedRevision,
  next,
}): Promise<boolean>;
```

A successful transition increments the revision. A rejected transition causes the gateway to reload
the operation and either return an already-committed idempotent result or report a typed conflict.

Receive handles remote outcomes as follows:

- an explicit rejection because the inputs were already spent moves the operation to `rolled_back`
  with the mint rejection in `error`;
- a transport failure leaves the operation executing;
- Operation Recovery replays the Exact Operation Request when all inputs remain unspent;
- when inputs are spent, Operation Recovery attempts Restore with the persisted outputs;
- restored expected outputs are saved and finalize the operation; and
- a successful Restore proving no expected outputs fails the operation.

## Query Modules

Query modules are application-scoped and constructed by the composition root. Orchestration modules
receive only the domain-specific queries they require, not an aggregate containing every query.

```ts
interface ProofQueries {
  getBalance(query: BalanceQuery): Promise<BalanceSnapshot>;
  previewSelection(intent: ProofSelectionIntent): Promise<ProofSelectionPreview>;
}
```

Query modules should hide meaningful behavior such as normalization, aggregation, availability
rules, stable ordering, or cross-repository projection. Do not introduce a query module that merely
renames repository methods.

Simple operation reads use narrow read-only ports such as `SendOperationQueries`. Repository
adapters may implement those interfaces directly, so a pass-through query class is unnecessary.
The composition root injects only the read port into orchestration; write repository methods remain
unavailable there.

Each query implementation owns its consistency policy. Queries that combine mutable records into
balances, history projections, or recovery diagnostics should use one read snapshot when the
adapter supports it. Simple informational lookups may use ordinary reads. Callers do not coordinate
repositories to construct a consistent projection.

Informational reads are suitable for display, diagnostics, and preflight:

```ts
const preview = await proofQueries.previewSelection(intent);
```

A mutation must not rely on that preview as current authority. The domain transaction gateway
re-reads or validates the relevant state inside its transaction before writing:

```ts
await proofTransactions.reserveForSend(intent);
```

The rule is:

> Read outside a transaction for information; read inside a transaction when the result authorizes
> a mutation.

## Remote I/O

Transaction modules must not receive network-capable dependencies. Mint requests, quote refreshes,
swaps, melts, issuance, and remote recovery observations remain in orchestration modules or injected
remote ports.

```ts
const authorization = await meltTransactions.beginExecution(command);

const remoteResult = await meltPort.execute(authorization.request);

const result = await meltTransactions.applyRemoteResult({
  operationId: authorization.operationId,
  remoteResult,
});
```

This shape makes the durable-before-remote rule visible and prevents holding a repository
transaction across network I/O.

The authorization object is not authoritative after the first transaction commits. That
transaction persists the exact remote request and returns its operation identity plus a request for
transport. The result transaction reloads the persisted operation by identity and verifies that the
observation applies to its persisted execution attempt. In-memory state cannot override the
durable operation record.

An operation owns one immutable Exact Operation Request. Initial submission and Operation Recovery
replay that same request; replay is not a new logical attempt. If request material must change, the
caller generally creates a new operation because the original request's remote effect may remain
ambiguous.

Only positive evidence that the Exact Operation Request had no effect may release reservations or
mark the operation failed. A timeout, malformed response, transport error, crash, or exhausted retry
policy does not prove non-effect. An Ambiguous Operation Outcome retains ownership of its proofs,
outputs, and reservations until Operation Recovery establishes a safe result. Any administrative
abandonment mechanism is a separate, explicit hazardous operation rather than an automatic timeout.

## Post-Commit Events

Transaction-scoped modules do not emit live events. A domain transaction gateway returns only after
its state change commits. Orchestration publishes the corresponding live event after that successful
return. A failed transaction publishes no event, and listeners cannot observe uncommitted state.

This first milestone keeps the current best-effort event-delivery guarantee. A process crash after
commit but before publication can lose the event. Durable at-least-once delivery, event ordering,
deduplication, and restart scanning belong to a separate future outbox feature.

If a live event listener fails after commit, orchestration logs the event error and still returns
the committed operation result. Event delivery failure must not cause a caller to retry a successful
Send or Receive. The future outbox can harden delivery without changing transaction gateway
interfaces.

## Dependency Rule

Repository imports should be restricted to:

- repository interfaces and adapters;
- query-module implementations;
- transaction-module implementations; and
- composition-root wiring.

Orchestration modules depend on query interfaces, narrow domain transaction gateways, and remote
ports. They must not import repositories, including for read-only access, receive the raw runner, or
combine root repositories with transaction-scoped modules. Query interfaces should still be
introduced only when they hide a meaningful read policy or projection; this rule does not justify
shallow repository aliases.

## Testing

The transaction runner and transaction modules are tested through their interfaces using memory
and persistent repository adapters.

Required contract cases include:

- every grouped mutation commits atomically;
- representative failures roll back the complete grouped write set;
- transaction reads do not observe concurrent uncommitted writes;
- root writes cannot be clobbered by transaction commit or rollback;
- no event is externally observable before commit;
- no transaction module performs remote I/O.

Persistent adapters must also prove that independent connections either serialize conflicting
transactions or reject one with a typed conflict. The memory adapter provides the same atomic
commit, rollback, isolation, and conflict behavior within one process; only persistence across
process termination is outside its contract.

Orchestration tests use in-memory remote adapters and the transaction runner rather than mocking
individual repositories. Tests should assert durable outcomes through query interfaces.

The first hardening milestone uses focused crash-resistance tests at local transaction boundaries.
It does not build a general network fault-injection matrix. Existing simple remote stubs are enough
to check the durable-before-remote and apply-after-remote phases. A future fault-adapter framework
will own systematic transport failures, crash points around remote effects, and broader saga chaos
testing.

## Migration

Adopt the design incrementally rather than rewriting all core modules at once. The first hardening
milestone is deliberately limited to proofs, deterministic output counters, and keypairs. Send and
core Receive are separate vertical migrations within that milestone. Send exercises owned-proof
selection, reservation, spending, deterministic outputs, and P2PK output construction. Receive
exercises incoming proof processing, deterministic proof creation, replay and Restore, and P2PK
signing with an existing key. Neither workflow exercises local keypair allocation, which receives
separate transaction contract coverage:

1. Introduce `CoreTransactionRunner` and `TransactionModuleFactory` as internal modules.
2. Implement proof and keypair transaction gateways, including atomic counter and derivation-index
   allocation.
3. Add cross-adapter atomicity and concurrency contracts for proofs, counters, and keypairs.
4. Migrate Send preparation, result application, prepared cancellation, normal finalization, and
   execution recovery through deep transaction commands. Defer pending default-token reclaim.
5. Migrate core Receive preparation, result application, rollback, and recovery through deep
   transaction commands. Preserve source metadata but defer Payment Request parent and attempt
   atomicity.
6. Migrate Mint Swap preparation and result application; remove the fake planning proof service and
   `ProofService.forTransaction()`.
7. Add rollback contracts covering the complete Mint Swap write set.
8. Migrate standalone mint and melt workflows where they share the same proof invariants.
9. Migrate Payment Request workflows when they require parent, attempt, and child atomicity.
10. Remove direct repository dependencies from each orchestration module after its migration.

Do not make the full migration a prerequisite for Mint Swap. New transaction-aware work should use
the shared seam, while existing workflows move behind it in reviewable slices.

## Non-Goals

- Holding repository transactions across remote I/O.
- Providing transaction-scoped clones of every existing orchestration module.
- Replacing repository adapters or their transaction implementations.
- Forcing informational reads into transactions.
- Introducing query modules that are only repository pass-throughs.
- Exposing `CoreTransaction` through public Coco APIs.
- Persisting creation intents for mint quotes that were never recorded or exposed to a caller.
- Changing public P2PK key deletion behavior as part of transaction hardening.
- Migrating Payment Request parent and attempt state with the first core Receive slice.
- Building the future network fault-adapter framework in the first hardening milestone.
- Adding local claims or duplicate suppression for incoming Receive proofs.
- Building a durable outbox or changing current event-delivery guarantees.
- Migrating pending default-token Send reclaim in the first Send slice.
