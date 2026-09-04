# Transaction Design

Status: accepted
([ADR-0011](./packages/core/docs/adr/0011-use-domain-transaction-gateways.md))

## Purpose

This document defines Coco's application-level transaction architecture for crash-safe and
concurrency-resistant Wallet mutations. It is the authoritative interface and dependency contract
for code that coordinates repository-backed state.

Uniformity means that code requiring atomicity follows one recognizable seam. It does not mean
that every Service, Query, or remote operation runs in a transaction.

The design separates four roles:

1. an Operation Service coordinates the lifecycle of one durable operation;
2. Queries and local capabilities provide narrow non-mutating dependencies;
3. an application-scoped `*Transactions` interface owns committed transaction commands; and
4. transaction-scoped modules perform authoritative local reads and writes within one adapter
   transaction.

`Coordinator` describes the architectural role of an Operation Service. It is not a required class
suffix. Established names such as `SendOperationService` and `ReceiveOperationService` remain.

## Decision Summary

- The composition root owns one application-scoped `CoreTransactionRunner` for a Coco Session.
- Each method on an application-scoped `*Transactions` interface opens exactly one adapter
  transaction through that runner and returns only after commit.
- An application-scoped `*Transactions` implementation is a leaf adapter; its caller completes
  preflight, and the gateway does not depend on Services or other effectful application modules.
- An Operation Service receives its own domain's `*Transactions` interface, not the raw runner or
  repositories.
- An Operation Service must not use another domain's application-scoped `*Transactions` interface
  to construct a supposedly atomic transition.
- Cross-domain writes compose through transaction-scoped modules created from the same short-lived
  `CoreTransaction` scope.
- Transaction-scoped modules never open transactions. They cannot depend on regular Services,
  application-scoped transaction gateways, remote infrastructure, or the live event bus.
- Preflight and remote mint I/O happen outside repository transactions. Inputs that must remain
  stable across retries are fixed before the transaction begins.
- An informational read may happen outside a transaction, but any read authorizing a mutation is
  repeated or validated inside the transaction.
- Live events are published only after commit.
- Existing dependency violations may be allowlisted temporarily. Every exception is exact and
  named; the executable architecture check rejects new edges and stale exceptions.

## Modules, Interfaces, and Lifetimes

The composition root constructs long-lived application modules for one Coco Session:

```text
Manager / composition root
  |-- repositories
  |-- Queries and narrow local capabilities
  |-- remote interfaces and adapters
  |-- CoreTransactionRunner
  |     `-- creates one short-lived CoreTransaction per run()
  |           |-- transaction.proofs
  |           |-- transaction.counters
  |           |-- transaction.keypairs
  |           |-- transaction.sends
  |           |-- transaction.receives
  |           |-- transaction.mintOperations
  |           `-- transaction.meltOperations
  |-- KeyRingTransactions
  |-- SendTransactions
  |-- ReceiveTransactions
  |-- KeyRingService
  |-- SendOperationService
  `-- ReceiveOperationService
```

The names in the diagram illustrate the shape; modules are added incrementally as domains migrate.
There is no application-scoped aggregate gateway that an Operation Service can use to reach every
domain.

The runner creates a `CoreTransaction` and all of its transaction-scoped modules from the exact
same `RepositoryTransactionScope`. Callers must not retain that scope, the `CoreTransaction`, or a
transaction-scoped module after `run()` completes.

```ts
export interface CoreTransaction {
  readonly proofs: TransactionalProofOperations;
  readonly keypairs: TransactionalKeypairOperations;
  readonly sends: TransactionalSendOperations;
  readonly receives: TransactionalReceiveOperations;
}

export interface CoreTransactionRunner {
  run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}
```

The concrete runner and repository adapters are composition-root mechanisms. They are not
dependencies of an Operation Service.

## Operation Services

An Operation Service is the application coordinator for one durable operation. It owns the order
of preflight, committed local transitions, remote calls, recovery decisions, and post-commit event
publication.

A migrated Operation Service depends only on the narrow interfaces its lifecycle discloses:

```ts
class SendOperationService {
  constructor(
    private readonly operations: SendOperationQueries,
    private readonly signer: P2pkSigner,
    private readonly remote: SendRemote,
    private readonly transactions: SendTransactions,
    private readonly events: SendEventPublisher,
  ) {}
}
```

These dependencies expose their effects:

- Queries provide informational or persisted-operation reads;
- local capabilities perform narrow in-process work such as signing;
- remote interfaces perform mint I/O;
- the Operation Service's own `*Transactions` interface commits local state; and
- a publisher emits live events after commit.

Broad regular Services are not substitutes for those interfaces. For example, depending on a
whole `KeyRingService` when only P2PK signing is needed conceals both authority and effects.
`KeyRingService` remains the user-facing keyring management module; internal consumers should use
narrow capabilities such as `P2pkSigner` or keypair Queries as they migrate.

An Operation Service does not receive repositories or `CoreTransactionRunner`. It also does not
receive another domain's application-scoped gateway to combine multiple gateway calls and call the
sequence atomic. Separate gateway calls are separate adapter transactions.

## Application-Scoped Transaction Gateways

An interface named `*Transactions` is the command seam used by an Operation Service or another
application coordinator. Every method owns exactly one call to `CoreTransactionRunner.run()`.

```ts
export interface SendTransactions {
  prepare(command: PrepareSendCommand): Promise<PreparedSend>;
  beginExecution(command: BeginSendCommand): Promise<AuthorizedSend>;
  applyResult(command: ApplySendResultCommand): Promise<SendResult>;
}
```

The method resolves only after its adapter transaction commits. It rejects if the transaction does
not commit. Callers can therefore publish a corresponding live event after a successful return
without exposing uncommitted state.

The implementation is a leaf adapter around its runner. Callers complete preflight before invoking
it and pass stable, transaction-ready command data. For example, the Keyring management
coordinator or a narrow keypair capability loads the Wallet Seed and creates a synchronous,
purpose-bound deriver before asking the keyring gateway to allocate a keypair. A transaction
gateway must not depend on regular Services, perform remote mint I/O, publish live events, access
root repositories directly, or call another application-scoped transaction gateway.

Cross-domain writes use modules from one `CoreTransaction`:

```ts
class CoreSendTransactions implements SendTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(command: PrepareSendCommand): Promise<PreparedSend> {
    return this.runner.run((transaction) => transaction.sends.prepare(command));
  }
}
```

`transaction.sends` can be constructed with transaction-scoped proof and counter modules from the
same scope. It can reserve proofs, allocate outputs, and persist the Send Operation as one atomic
transition. The application gateway never combines separate root transactions.

## Transaction-Scoped Modules

Transaction-scoped modules expose domain operations rather than generic repository mutation. Their
interfaces should make invalid state transitions difficult to express and should keep the complete
invariant local to the domain concept that owns it.

```ts
interface TransactionalProofOperations {
  selectAndReserve(command: SelectAndReserveProofs): Promise<ProofReservation>;
  settleSpend(command: SettleProofSpend): Promise<void>;
  releaseAfterNonEffect(command: ReleaseProofReservation): Promise<void>;
}
```

Avoid exposing unrestricted primitives to application orchestration:

```ts
interface UnsafeProofWrites {
  setProofState(secrets: string[], state: ProofState): Promise<void>;
  setCounter(keysetId: string, counter: number): Promise<void>;
}
```

A transaction-scoped implementation may use repository primitives internally while enforcing
ownership, unit consistency, expected revisions, legal states, and allocation rules.

When one transition spans several repository-backed concepts, the owning transaction-scoped module
coordinates peer modules created from the same `CoreTransaction` scope. Repository count does not
justify a neutral workflow bucket. A Send preparation belongs to the Send module even when it uses
proof and counter modules; a Mint Swap transition belongs to the Mint Swap module even when it
creates a child Melt Operation.

Transaction-scoped modules never call `CoreTransactionRunner.run()` or repository
`withTransaction()`. They never depend on:

- regular Services;
- application-scoped `*Transactions` gateways;
- remote infrastructure or network-capable adapters; or
- the live `EventBus`.

Command/result types, pure domain logic, logging types, scoped repositories, and peer
transaction-scoped modules are valid dependencies when the owning invariant requires them.

## Transaction Flow

The standard remote-effect shape is:

```text
preflight -> authorize transaction -> remote I/O -> apply transaction -> publish
```

Preflight is owned by the Operation Service or narrow local capability that coordinates the use
case. It resolves dependencies that are unsafe or unnecessary to await inside an adapter
transaction. It may normalize input, load a Wallet Seed, build a synchronous signer or deriver, or
prepare stable identifiers and timestamps. Any value that must remain unchanged across a bounded
transaction retry is fixed here.

The authorization transaction reloads authoritative local state, validates the transition, and
persists the Exact Operation Request before remote I/O. The remote call happens with no repository
transaction open. The result transaction reloads the durable operation by identity and validates
that the observation belongs to its persisted request before applying it.

```ts
const authorization = await transactions.beginExecution(command);
const remoteResult = await remote.execute(authorization.request);
const result = await transactions.applyResult({
  operationId: authorization.operationId,
  remoteResult,
});
events.publish(result);
```

An authorization object is transport input, not continuing authority over local state. The next
transaction reads the durable record again.

## Reads, Queries, and Mutation Authority

Queries are application-scoped, read-only interfaces. They should hide meaningful behavior such as
normalization, aggregation, availability policy, stable ordering, or a cross-repository projection.
A repository adapter may directly implement a narrow read interface when a pass-through Query
module would add no depth.

Informational reads support display, diagnostics, and preflight:

```ts
const preview = await proofQueries.previewSelection(intent);
```

The preview cannot authorize a later mutation because concurrent Coco Sessions may change Wallet
state. The transaction-scoped operation reads or validates the current proof state again before
writing:

```ts
await sendTransactions.prepare(command);
```

The rule is:

> Read outside a transaction for information; read inside a transaction when the result authorizes
> a mutation.

## Concurrency and Retry

One runner invocation covers one atomic Wallet persistence boundary. Every transaction-scoped
module used by it shares the same adapter transaction scope. Nested and distributed transactions
are unsupported. An adapter combination unable to provide the shared scope must not be constructed
as a `CoreTransactionRunner`.

Independent Coco Sessions using the same Wallet storage must not silently lose committed updates.
An adapter may serialize conflicting work or reject one participant with a typed transaction
conflict. The runner retries only conflicts the adapter explicitly marks transient, with a small
bounded policy.

Retryable commands must be replay-safe. Stable operation IDs, timestamps, Exact Operation Request
material, and other retry-sensitive values are fixed before the callback begins. Each attempt
repeats its authoritative reads in a fresh transaction. Exhausted contention is returned as a typed
error.

SQLite adapters use their strong write transaction mode. IndexedDB uses one read-write transaction
and is the portability baseline: work inside the callback must not allow its transaction to become
inactive before required reads and writes are scheduled. Adapter-specific modes do not leak through
domain transaction interfaces.

## Allocation Semantics

An Output Allocation commits deterministic counter positions with the output plan that consumes
them. A Keypair Allocation commits one purpose-specific Wallet derivation index with its derived
keypair. Derivation performed by a transaction that rolls back is not an allocation and may be
repeated.

Committed counter positions and derivation indexes are never reclaimed, including after an
operation aborts or a keypair is deleted. This prevents accidental deterministic reuse.

The Keyring management coordinator or a narrow keypair capability performs asynchronous Wallet
Seed loading and gives the keyring gateway a synchronous, purpose-bound deriver. The gateway passes
that deriver into its one transaction. Inside the transaction, the transaction-scoped keypair
module reads the durable high-water mark, chooses the next index, derives the keypair, and persists
the keypair and high-water mark atomically.

## Remote Outcomes and Recovery

An operation owns one immutable Exact Operation Request. Initial submission and Operation Recovery
reuse that request; replay is not a new logical attempt. If request material must change, the caller
creates a new operation because the original request's remote effect may remain ambiguous.

Only positive evidence that an Exact Operation Request had no effect may release owned resources or
mark the operation failed. A timeout, malformed response, transport failure, crash, or exhausted
retry policy does not prove non-effect. An Ambiguous Operation Outcome retains its proofs, outputs,
and reservations until Operation Recovery establishes a safe result.

In-memory locks may reduce contention but are not correctness mechanisms. Durable operations use
monotonic revisions or equivalent conditional transitions so concurrent commands cannot both
advance the same state.

## Post-Commit Events

Transaction-scoped modules never emit live events. Application transaction gateways return after
commit, and the Operation Service publishes the corresponding event only after that return. A
failed transaction publishes no event.

This preserves Coco's current best-effort delivery guarantee. A process crash between commit and
publication can lose a live event. Durable at-least-once delivery, ordering, and deduplication are a
future outbox concern.

If a listener fails after commit, orchestration logs the event error without treating the committed
Wallet mutation as failed. Event failure must not cause a caller to replay a successful remote
effect.

## Executable Dependency Rules

[`scripts/check-transaction-architecture.ts`](./scripts/check-transaction-architecture.ts) inspects
TypeScript imports during `bun run typecheck`. File naming and placement make the architectural
roles recognizable:

- `transactions/**/Transactional*Operations.ts` contains transaction-scoped implementations;
- `transactions/**/*Transactions.ts` contains application-scoped transaction gateways; and
- `operations/**/*OperationService.ts` contains durable operation coordinators.

The check enforces these edges:

| Importer                                          | Forbidden dependencies                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Transaction-scoped implementation                 | regular Services, remote infrastructure, live event bus, raw runner, application-scoped gateways   |
| Application-scoped `*Transactions` implementation | regular Services, remote infrastructure, live event bus, repositories, application-scoped gateways |
| Operation Service                                 | regular Services, repositories, `CoreTransactionRunner`, another domain's transaction gateway      |

Repository interfaces remain visible to repository adapters, Query implementations,
transaction-scoped implementations, and composition-root wiring. They are not orchestration
dependencies.

The check uses an exact legacy allowlist including importer, import source, and imported binding
names. This includes the current Operation Service dependencies on broad Services and the keyring
gateway's temporary dependency on `SeedService`. Adding a binding to an allowlisted import is a new
violation. Removing a legacy edge makes its allowlist entry stale and fails the check until the
exception is deleted, so the allowlist must shrink with each migration.

## Incremental Migration

The architecture is adopted in reviewable vertical slices. New transaction-aware work follows this
contract immediately; existing workflows move behind it without requiring a repository-wide
rewrite.

1. Establish the runner, transaction-scoped module factory, keypair allocation, architecture
   contract, and executable dependency guard.
2. Move Wallet Seed loading and derivation preparation out of the keyring transaction gateway;
   replace broad Keyring dependencies used internally with purpose-specific Queries and local
   capabilities while retaining `KeyRingService` as the user-facing management module.
3. Migrate Send transitions through `SendTransactions` and remove its allowlisted repository edge.
4. Migrate core Receive transitions through `ReceiveTransactions` and remove its allowlisted edge.
5. Migrate Mint Swap, Mint Operation, Melt Operation, and Payment Request transitions as their
   cross-domain invariants require.

Payment Request Receive parent, attempt, and child atomicity is intentionally deferred until that
workflow's migration. Existing operation names remain stable throughout the migration.

## Testing Contract

Transaction runners and scoped modules are tested through their interfaces with memory and
persistent adapters. Required cases include:

- grouped writes commit atomically;
- representative failures roll back the whole write set;
- transaction reads do not observe concurrent uncommitted writes;
- root writes cannot be clobbered by transaction commit or rollback;
- independent connections serialize or return a typed conflict; and
- no live event or remote I/O occurs inside a transaction.

Architecture-check tests cover rejected imports, exact legacy exceptions, additions to allowlisted
imports, and the current source tree. Orchestration tests assert durable results through Queries and
use in-memory remote adapters rather than mocking individual repositories.

## Non-Goals

- Holding repository transactions across remote I/O.
- Renaming Operation Services to Coordinators.
- Giving an Operation Service repositories or the raw runner.
- Combining application-scoped gateways to simulate one transaction.
- Creating transaction-scoped clones of broad regular Services.
- Forcing informational reads into transactions.
- Exposing `CoreTransaction` through public Coco interfaces.
- Redesigning Payment Request Receive atomicity in the first migration step.
- Building systematic network fault injection or a durable outbox in this milestone.
