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

> Organize modules around domain invariants, make their effects explicit, and give each atomic
> state transition exactly one transaction owner. Shared domain modules own reusable rules and
> algorithms; operation-specific modules compose them into atomic transitions. Narrow interfaces
> limit authority and do not require separate implementations.

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
- A module that participates inside a transaction cannot possess or obtain through helpers the
  ability to start another transaction. Never accept an optional transaction argument that opens
  a new transaction when omitted.
- Queries and preflight capabilities never silently initialize storage, allocate keys, advance
  counters, repair records, or invoke a transaction gateway.
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
This is not a required catalogue of interfaces. For example, counters can remain a private
dependency of Output Allocation rather than a member of `CoreTransaction`. Add a shared module
where it encapsulates an invariant; do not reproduce one class per existing Service or repository.
There is no application-scoped aggregate gateway that an Operation Service can use to reach every
domain.

The runner creates a `CoreTransaction` and all of its transaction-scoped modules from the exact
same `RepositoryTransactionScope`. Callers must not retain that scope, the `CoreTransaction`, or a
transaction-scoped module after `run()` completes.

```ts
export interface CoreTransaction {
  readonly proofs: TransactionScopedProofCommands;
  readonly keypairs: TransactionScopedKeypairCommands;
  readonly sends: TransactionScopedSendCommands;
  readonly receives: TransactionScopedReceiveCommands;
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
That invocation opens one adapter transaction per attempt; bounded retries roll back and repeat
sequentially, never nest. A thin gateway earns its place by guaranteeing an atomic committed result.

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
Pure validation and normalization can remain inside the gateway. Preflight separation concerns
effects and transaction lifetime, not a requirement to move every computation into another class.

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

## Shared Behavior and Transaction Ownership

Share implementations across workflows. Send and Mint can use the same output allocator; Send
and Melt can use the same proof reservation rules. The runner constructs each shared implementation
with repositories from the current attempt's scope. Share the algorithm, never a live scope across
transactions or concurrent callers.

```text
SendTransactions.prepare -> runner -> scoped Send preparation
                                      |-- shared proof reservation
                                      |-- shared output allocation
                                      `-- persist prepared Send Operation

MintTransactions.prepare -> runner -> scoped Mint preparation
                                      |-- same output allocation implementation
                                      `-- persist pending Mint Operation
```

The owning transition couples allocation to its persisted output plan. A generic counter increment
cannot provide that guarantee on its own. A standalone key-management action uses
`KeyRingTransactions`; another owning transition allocates keys through `transaction.keypairs`
within its existing scope. It never calls the standalone gateway.

Queries, fee calculations, proof selection algorithms, derivation, and unblinding are also shared.
An informational selection and an authoritative reservation can use the same selection algorithm;
the latter reads current state and reserves the result within its transaction. A coordinator does
not need a private copy of each Query or capability. Multiple narrow interfaces may have one
implementation, and a repository adapter may satisfy a read interface directly.

Reserve `Operation` for durable sagas. Name transaction-scoped interfaces
`TransactionScoped*Commands`, with implementations such as `RepositoryKeypairCommands`. Callers
still use small domain methods: `transaction.keypairs.allocate(command)`. Keep all scoped
implementations and their private scoped helpers under `transactions/scoped/` so the architecture
guard applies independently of class names. Do not add interfaces or pass-through classes solely
to reproduce the same layers for every domain.

## Implemented Keypair Baseline

The first slice implements this separation without changing the user-facing KeyRing API:

- `keypairs/KeypairQueries.ts` exposes reads of existing keys. The key-ring repository already
  satisfies it; no query wrapper is needed.
- `keypairs/KeypairDerivation.ts` loads the Wallet Seed during preflight and prepares a synchronous,
  purpose-bound deriver. It cannot allocate or persist a key. The injected seed loader is read-only.
- `keypairs/P2pkSigner.ts` contains the shared signer. `KeyRingService` and `ProofService` receive
  the same implementation; ProofService has no key-management dependency.
- `services/KeyRingService.ts` coordinates user-facing key management and invokes preflight before
  calling its own gateway. Existing management and signing methods remain available for callers.
- `transactions/keypairs/KeyRingTransactions.ts` receives only the runner and forwards prepared
  commands into one transaction.
- `transactions/scoped/keypairs/TransactionScopedKeypairCommands.ts` receives only a scoped
  key-ring repository. Standalone and composed key allocations use this same implementation.

No keypair dependency exception remains. Other legacy key-management consumers, including mint
quote handlers, migrate with their owning workflows; a narrow signing interface must never be a
disguise for `getOrCreateKey()` or other hidden persistence.

## Applying the Baseline to Later Refactors

The following are target responsibilities, not additional implementations in the keypair slice:

| Existing responsibility                             | Target owner                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| ProofService balance aggregation                    | Shared Wallet balance queries                                            |
| Proof lookup for display                            | Shared proof queries                                                     |
| Fee calculation, selection, derivation, unblinding  | Shared computation and explicit preflight inputs                         |
| Proof selection and reservation authorizing a spend | Scoped proof commands within the owning Send/Melt transition             |
| Output creation and counter advancement             | Shared scoped Output Allocation, committed with the consuming operation  |
| Saving issued or recovered proofs                   | Scoped proof commands within the owning result transition                |
| Remote restore and proof-state checks               | Explicit remote adapters driven by a coordinator                         |
| Counter overwrite during Restore                    | Scoped high-water-mark advancement that never lowers committed positions |
| Proof/counter events                                | Public event descriptions published by the coordinator after commit      |

For example, `manager.ops.mint.prepare({ quote, amount })` can keep its public interface while
MintOperationService receives shared operation queries, preflight, `MintTransactions`, a remote
interface, and an event publisher. Preparation atomically commits Output Allocation with the
pending Mint Operation. Pending preparation does not itself reserve paid quote value. Authorization
checks current claimability and commits the reservation, executing state, and Exact Operation
Request; application of issuance atomically saves validated proofs and completes local accounting
and operation state.

Mint method handlers must relinquish repositories, broad Services, and live event publication as
part of that migration. Protocol adapters return observations or candidate proofs; the owning
transaction validates and persists them. Canonical Quote Observations precede operation advancement
as required by ADR-0004. Remote recovery, unblinding, and persistence are separate effects but share
their existing algorithms. `manager.wallet.balances.total()` needs only shared balance queries.

## Transaction-Scoped Modules

Transaction-scoped modules expose domain operations rather than generic repository mutation. Their
interfaces should make invalid state transitions difficult to express and should keep the complete
invariant local to the domain concept that owns it.

```ts
interface TransactionScopedProofCommands {
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

Preflight is owned by the application coordinator or narrow local capability that supports the use
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
TypeScript syntax and dependencies during `bun run typecheck`. File naming and placement make the architectural
roles recognizable:

- `transactions/scoped/**` contains shared and operation-specific scoped implementations and helpers;
- `transactions/**/*Transactions.ts` contains application-scoped transaction gateways; and
- `operations/**/*OperationService.ts` contains durable operation coordinators.
- `keypairs/**`, `queries/**`, and `capabilities/**` contain non-mutating queries, preflight,
  and local capabilities. Put future shared read capabilities in one of these checked locations.

The check enforces these edges:

| Importer                                          | Forbidden dependencies                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transaction-scoped implementation                 | Services/coordinators, remote infrastructure, live event bus, raw runner, root repository containers, concrete storage adapters, application-scoped gateways |
| Application-scoped `*Transactions` implementation | regular Services, remote infrastructure, live event bus, repositories, application-scoped gateways                                                           |
| Operation Service                                 | regular Services, repositories, `CoreTransactionRunner`, another domain's transaction gateway                                                                |
| Query or local preflight capability               | Services/coordinators, repository mutation interfaces, transaction modules, remote infrastructure, live event bus                                            |

Scoped implementations import repository contracts with `import type`; runtime repository helpers
and concrete adapters cannot be used to acquire an opener. Repository adapters and composition-root
wiring retain full persistence contracts. Queries receive narrow read interfaces, which a repository
adapter can implement directly; query modules do not import broad mutation contracts.

The check uses an exact legacy allowlist including importer, import source, and imported binding
names and, for indirect dependencies, the exact helper path. This includes current Operation
Service dependencies on broad Services and the legacy Melt handler dependency bundle. Adding a
binding or another helper path to an allowlisted dependency is a new
violation. Removing a legacy edge makes its allowlist entry stale and fails the check until the
exception is deleted, so the allowlist must shrink with each migration.

The guard parses imports, re-exports, import types, literal dynamic imports, and require calls with
TypeScript. It follows runtime helper dependencies and type re-exports. Type-only imports do not
grant access to the imported module's implementation; they are checked directly and through
re-export chains. Permitted architectural seams such as a coordinator's own gateway are checked
separately rather than inheriting the consumer's role. Root runner imports and explicit
`withTransaction` access are limited to gateways and declared transaction infrastructure; gateways
must use the runner rather than `withTransaction` directly. Coordinators cannot receive live scoped
commands. The guard rejects syntactically nested runner calls in gateway callbacks. Restricted
modules also reject direct network primitives and non-literal dependency loading.

This is a guard against accidental architectural drift, not a proof of arbitrary JavaScript
effects. Structural type aliases, injected callbacks, casts, computed property names, third-party
implementations, and composition-root wiring still require review and behavior tests. The
composition root must supply non-mutating query/preflight implementations and scoped repositories
without transaction openers. Never infer purity from a small interface alone. Do not implement a
process-wide "transaction active" flag: independent concurrent transactions are valid, while
nested transactions within a call chain are forbidden.

## Incremental Migration

The architecture is adopted in reviewable vertical slices. New transaction-aware work follows this
contract immediately; existing workflows move behind it without requiring a repository-wide
rewrite.

1. Establish the runner, transaction-scoped module factory, keypair allocation, architecture
   contract, and executable dependency guard.
2. Use the implemented Keypair Queries, derivation, signer, and shared scoped commands as the
   baseline; retain `KeyRingService` as the user-facing management module.
3. Migrate Send transitions through `SendTransactions`, extracting shared proof and Output
   Allocation behavior, separating handler effects, and removing its legacy dependency exceptions.
4. Migrate core Receive transitions through `ReceiveTransactions`, reusing those implementations
   and removing its legacy dependency exceptions.
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

The keypair baseline also tests shared command reuse through a standalone gateway and a composed
transition, exactly one adapter transaction per successful invocation, grouped allocation rollback,
high-water-mark rollback, synchronous reusable derivation, and signing through read-only key access.
Compile-time assertions ensure neither domain scope nor repository scope exposes a transaction
opener. Later migrations must exercise the same composition guarantees across proofs, allocation,
and operation persistence, including adapter concurrency and ambiguous remote outcomes.

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
