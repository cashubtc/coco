# Transaction Design

Status: accepted
([ADR-0011](./packages/core/docs/adr/0011-use-domain-transaction-gateways.md))

## Purpose

Coco coordinates crash-safe Wallet mutations through one transaction runner per Coco Session.
The outermost local workflow owns the transaction. Functions and capabilities participating in that
workflow receive the same short-lived scope and cannot open transactions themselves.

There are three responsibilities:

| Role                 | Responsibility                                                       | Example                             |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| Coordinator          | Orders preflight, transactions, remote effects, recovery, and events | `SendOperationService`              |
| Transaction function | Composes the local changes that form one domain transition           | `prepareSend(tx, input)`            |
| Scoped capability    | Encapsulates reusable local rules                                    | `tx.proofs.selectAndReserve(input)` |

`CoreTransactionRunner` owns scope construction, commit, rollback, and bounded retries. A
transaction function does not commit: its caller may compose additional work before returning.
There is no required domain gateway, mirrored workflow interface, or per-workflow scope type.

## Runner Injection and Scope Lifetime

The composition root creates one application-scoped runner and injects its interface into
coordinators. The concrete runner receives the root repositories; coordinators do not.

```ts
const transactionRunner = new RepositoryCoreTransactionRunner(repositories, outputDataCreator);
const sendService = new SendOperationService({ transactionRunner /* other dependencies */ });
const keyRingService = new KeyRingService(keypairQueries, transactionRunner, derivation, signer);
```

Each `run()` invocation opens one adapter transaction per attempt. Sharing the runner does not
share an open transaction. A successful return means commit completed; a rejection means the
attempt did not commit. Nested and distributed transactions are unsupported.

```ts
interface CoreTransactionRunner {
  run<T>(work: (tx: CoreTransaction) => Promise<T>): Promise<T>;
}
```

`CoreTransaction` exposes domain capabilities and narrow scoped persistence interfaces. Every capability
is constructed from the same `RepositoryTransactionScope`. It has no runner, root repository
container, remote client, or live event bus. Never retain a scope or its capabilities after `run()`.
Never accept an optional transaction argument that opens a new transaction when omitted.

The runner binds repositories and capabilities to one internal `TransactionLifetime` per attempt.
The lifetime rejects expired calls, remembers the first failure, and drains started work before
commit, rollback, or retry. The lifetime has no transaction-opening authority.

Transaction functions use `trackTransactionWork(tx, work)` internally to enroll the whole
function in that same lifetime. This preserves containment after removing workflow-class wrappers:
a caught validation failure cannot commit earlier writes, and an accidentally dropped function
promise cannot commit only its first mutation. The helper never opens or commits a transaction and
rejects scopes not bound by the runner. Pass the original scope; narrowing its TypeScript type does
not require copying it. Pure calculations and private helpers awaited by a tracked function need
no additional wrapper.

## Composition

A coordinator may compose scoped capabilities directly. Extract a named transaction function when the
sequence expresses a meaningful domain invariant or prevents duplication. A function receives the
shared `CoreTransaction`; a `Pick` may narrow its type when useful, without introducing another
scope factory or interface hierarchy.

```ts
// A standalone transition.
const prepared = await transactionRunner.run((tx) => prepareSend(tx, input));

// A larger local workflow, using the same implementation and adapter transaction.
const result = await transactionRunner.run(async (tx) => {
  const prepared = await prepareSend(tx, input);
  const authorized = await beginSendExecution(tx, executionInput);
  return { prepared, authorized };
});
// Remote execution can now use the committed authorization.
```

If the second transition fails, proof reservation, Output Allocation, and the prepared Send all
roll back. The outer callback owns the additional invariant connecting its transitions. Separate
`run()` calls are separate commits even when they use the same runner. For atomic composition,
reuse transaction functions, not service entry points that independently commit.

Capabilities encapsulate real rules: proof selection and reservation, output derivation with counter
advancement, and keypair derivation with index advancement. Do not expose raw counters merely to
let every workflow rebuild allocation rules. The owning transition persists the output plan with
its allocation in the same transaction. Narrow operation persistence contracts may be implemented
directly by scoped repositories; a forwarding class adds no guarantee.

Await dependent capability calls sequentially. `Promise.all()` is appropriate only when interleaved reads
and writes cannot violate a shared invariant. Lifetime tracking provides containment, not ordering;
it does not make concurrent allocations for the same purpose safe within one scope.

## Coordinator Effects

A `<Domain>Service` coordinates management actions. A `<Domain>OperationService` additionally owns
a durable saga lifecycle. Both may receive the runner, Queries, local capabilities, explicit remote
interfaces, and event publication dependencies.

Preflight resolves asynchronous dependencies and fixes retry-sensitive inputs before `run()`:
Wallet Seed loading, IDs, timestamps, random outputs, purpose-bound synchronous derivers, and
method policy. Informational reads may occur here. Any read authorizing a mutation must be repeated
or validated inside the transaction. Queries and local computation never silently initialize or
repair storage, allocate keys, advance counters, or commit.

```text
preflight -> authorize transaction -> remote I/O -> apply transaction -> publish
```

```ts
const authorization = await transactionRunner.run((tx) => beginSendExecution(tx, executionInput));
const remoteResult = await remote.execute(authorization.request);
const resultInput = prepareResultInput(authorization, remoteResult);
const result = await transactionRunner.run((tx) => applySendResult(tx, resultInput));
await publishCommittedEvents(result);
```

Callbacks contain local work only. Do not close over remote clients, seed loaders, coordinators,
timers, event buses, root repositories, or another transaction opener. TypeScript cannot prove this
restriction; review the callback and its helpers. The authorization object is transport input,
not continuing authority over local state. Application of a result reloads the durable operation
and validates that the result belongs to its persisted request.

Coordinators may reuse narrow independently committed workflows outside transactions. For example,
`MintService.refreshAndCommitIfStale` owns freshness policy, remote metadata fetch, its transaction,
and attempted post-commit publication. Send receives that action through a narrow interface. Its
metadata commit intentionally survives a later Send failure; a cached path opens no transaction.
Coordinator dependencies remain acyclic. Transaction functions and scoped capabilities never receive
these actions.

Mint metadata application returns the committed snapshot and an applied/ignored disposition.
Older observations and timestamp ties retain the first committed snapshot. Only applied observations
publish refresh events, preventing ignored observations from resetting batch-polling suppression.

## Persistence, Retry, and Recovery Guarantees

All reads and writes authorizing a local transition use one adapter scope. Independent Coco Sessions
sharing Wallet storage must not lose committed updates. Adapters either serialize conflicting work
or return a typed transaction conflict. The runner retries only explicitly transient repository
conflicts, with a small bounded policy and a yield after rollback. Each attempt gets fresh scoped
capabilities and repeats the whole callback, never individual allocation steps.

SQLite adapters use their strong write transaction mode. IndexedDB is the portability baseline:
do not await unrelated asynchronous work that lets its transaction become inactive. Adapter-specific
modes remain inside adapters. Adapter combinations unable to provide one shared transaction cannot
back a `CoreTransactionRunner`.

A scoped failure immediately rejects further work. Already executing work settles inside its
original transaction before rollback or retry. Catching a failure or using `Promise.allSettled()`
cannot turn a failed attempt into a commit. After completion, captured capabilities, repositories, and
transaction functions reject further use. Tracking does not cancel arbitrary JavaScript promises
or make external effects transactional; callers still return or await their work.

An Output Allocation commits deterministic positions together with the consuming output plan.
A Keypair Allocation commits a purpose-specific derivation index together with its keypair. A
rolled-back derivation is not an allocation and may be repeated. Committed positions are never
reclaimed, even after cancellation or deletion.

Keypair allocation reads the durable last allocated index and highest stored index, chooses their
maximum plus one, checks exhaustion, derives synchronously, and persists both keypair and high-water
mark. Imported keys remain compatible. Repositories persist values; they never derive keys or open
allocation transactions. Counter advancement during Restore must never lower committed positions.

An operation owns its immutable Exact Operation Request. Persist the request and authorization
before remote submission. Initial execution and Operation Recovery reuse it. Changed request
material requires a new operation because an earlier submission may have affected the mint.

Only positive evidence of non-effect permits releasing owned resources or recording failure.
Timeouts, transport errors, malformed responses, crashes, and exhausted retries leave an Ambiguous
Operation Outcome recoverable with its proofs, allocations, and reservations retained. Durable
revisions or equivalent conditional transitions prevent conflicting advancement; in-memory locks
are contention aids, not correctness mechanisms. Quote Observations precede Quote-backed Operation
advancement as specified by ADR-0004.

Events are published only after the owning `run()` returns. Scoped capabilitys and transaction functions
return results rather than emitting live events. A failed transaction publishes nothing. Listener
failures are logged without turning a committed mutation into a failure or replaying a remote effect.
Delivery remains best effort: a crash between commit and publication can lose an event. An outbox
is separate future work.

## Files and Dependencies

```text
operations/send/SendOperationService.ts       # workflow orchestration
services/KeyRingService.ts                    # key management orchestration
transactions/
  CoreTransaction.ts                         # scope, runner interface, implementation
  TransactionLifetime.ts                     # internal containment mechanism
  proofs/TransactionProofs.ts                 # shared proof rules and scoped persistence
  outputs/TransactionOutputs.ts               # output allocation including counters
  keypairs/TransactionKeypairs.ts             # keypair allocation and scoped persistence
  mints/TransactionMintMetadata.ts            # metadata application and trust checks
  transitions/
    send/
      SendTransitions.ts                     # complete Send lifecycle, including recovery
      SendTransitionTypes.ts                 # named transition inputs and results
      SendValidation.ts                      # pure validation and comparison helpers
```

Names describe authority and lifetime:

| Name                                           | Role                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `<Domain>Service` / `<Domain>OperationService` | Orchestrates preflight, local transactions, remote effects, and events.                               |
| `<Domain>Operation`                            | Durable saga state that survives individual transactions.                                             |
| `CoreTransaction`                              | Live scope for one transaction attempt, passed as `tx`.                                               |
| `CoreTransactionRunner`                        | Opens and completes transactions; injected as `transactionRunner`.                                    |
| `Transaction<Domain>`                          | Shared scoped capability with local reads and mutations, such as `TransactionProofs`.                 |
| `RepositoryTransaction<Domain>`                | Its repository-backed implementation, colocated with the interface.                                   |
| `<Domain>Transitions.ts`                       | Related named functions that compose local mutations within a supplied `tx`.                          |
| `<Action>Input` / `<Action>Result`             | Arguments and results named after the transition, such as `PrepareSendInput` and `PrepareSendResult`. |
| `<Domain>Queries`                              | Read-only queries outside a transaction; a repository may implement the interface directly.           |
| `<Domain>Remote` / `<Provider><Domain>Remote`  | Remote I/O boundary and its provider implementation.                                                  |
| `<Domain>Validation.ts`                        | Pure validation helpers with no persistence or remote effects.                                        |

Keep `CoreTransaction`, `CoreTransactionRunner`, and `RepositoryCoreTransactionRunner` together in
`CoreTransaction.ts`: they describe and implement the same boundary. Keep each capability interface
and implementation together too. Use `Transaction<Domain>` rather than `*Commands`, because these
capabilities include reads as well as mutations.

Workflow transitions live under `transactions/transitions/<domain>/`. Start with one
`<Domain>Transitions.ts` module for the complete lifecycle. In Send, order functions by preparation,
execution, completion, cancellation and reclaim, then recovery. Recovery reuses the same lifecycle
transitions, so its entry point does not determine a separate module boundary. Extract a smaller
`*Transitions.ts` module only when a cohesive responsibility warrants it; splitting by phase or by
individual function is optional.

Transition names are domain verbs such as `prepareSend(tx, input)`. Capability methods use short
verbs such as `tx.proofs.selectAndReserve(input)`. Prefer private helpers when only one module needs
them. Name shared helper and type files for their domain instead of generic `types.ts`, `inputs.ts`,
or `helpers.ts` files.

Transition input objects use the parameter `input`; the callback accepted by the runner is named `work`.
Do not duplicate the `Result` suffix when the action already ends with it: `applySendResult` uses
`ApplySendResultInput` and `ApplySendResult`. A transition's `changed` flag reports whether it changed
local state; it never claims that the outer transaction has committed. Publish only after `run()`
returns. Tests use the corresponding module or workflow name.

Inline input objects are normal. Hoist only asynchronous preflight, timestamps, randomness, and other
retry-sensitive material before `run()`. A named input remains useful when shared or built by
preflight; it is not required at every call site.

```ts
const updatedAt = Date.now();
const result = await transactionRunner.run((tx) =>
  applySendResult(tx, { operationId, updatedAt, keepProofs, sendProofs, token }),
);
if (result.changed) await publish(result);
```

Shared capabilities must never import workflow transitions. Transitions may compose capabilities
and other local transitions, but cannot import a runner or acquire transaction-opening authority.

| Module                             | Allowed dependencies                                                                                                | Forbidden authority                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Coordinator                        | Runner, transaction functions, Queries, local capabilities, remote interfaces, events, narrow independent workflows | Root repository mutation, retaining live scopes                               |
| Transaction function               | Supplied scope, other local transaction functions, pure helpers, lifetime tracking                                  | Runner, root repositories, coordinators, remote I/O, live events              |
| Scoped capability                  | Scoped repositories, peer capabilities, pure helpers                                                                | Transaction openers, root repositories, coordinators, remote I/O, live events |
| Query / local preflight capability | Read-only state interfaces, pure helpers, explicit local inputs                                                     | Persistence mutation, transaction openers, remote I/O, live events            |
| Runner / composition root          | Root repositories, adapters, scoped constructors, lifetime mechanism                                                | Workflow orchestration and remote effects inside attempts                     |

Scoped implementations import repository contracts with `import type`. Follow the authority actually
supplied through imported helpers and injected implementations; narrow types alone do not establish
purity. Use code review, scoped types, and behavior tests instead of a custom architecture checker.

## Agent Review

Before completing a change involving Wallet persistence, operation coordination, or adapters:

1. Identify each module's role and trace its dependencies, including helpers and composition-root
   wiring. Coordinators receive the shared runner; local functions and capabilities cannot open one.
2. Identify the owning `run()` for each atomic transition. Check that all participants use its scope,
   authoritative reads occur inside it, and dependent capability calls are sequential. Examine any concurrent
   group for safe interleaving.
3. Trace effects: asynchronous preflight and remote work outside, synchronous derivation inside,
   retry-sensitive inputs fixed before the callback, and events after commit. Independent workflow
   commits must intentionally survive caller failure and complete outside the caller's transaction.
4. Verify lifetime enrollment for extracted transaction functions, failure rollback, and expired scope
   rejection. Run relevant behavior tests; typecheck alone does not establish adherence.
5. Report inspected transaction boundaries, verification, and remaining legacy deviations. Update this
   design and ADR-0011 together when changing the contract.

## Migration and Verification

Send transitions, KeyRing mutations, and mint metadata refresh use coordinator-owned transactions.
Legacy Receive, Mint, Melt, Mint Swap orchestration, Payment Request Receive parent/attempt/child
atomicity, and MintService add/forced-update/trust/delete paths remain for their owning migrations.
Those migrations should reuse domain capabilities and local functions, rather than add domain gateways.
Runtime rejection of nested Wallet transactions remains nonuniform: IndexedDB rejects ambient
transactions, while Memory/SQLite root calls may queue behind an outer caller awaiting them. Do not
rely on a universal runtime guard; distinguishing nesting from legitimate concurrency remains work.

Behavior tests cover memory and persistent adapters:

- Standalone and composed functions use the same implementations and one transaction per attempt.
- Grouped proof, counter, operation, and keypair changes commit together or all roll back.
- A composed transition's validation failure rolls back earlier successful work, even if caught.
- Dropped function promises drain fully; finished scopes and captured methods reject later calls.
- Failed concurrent work drains before rollback/retry and cannot continue in a later attempt.
- Retried workflows preserve stable inputs and allocate only once in the committed attempt.
- Authoritative reservation and revision checks choose one concurrent winner.
- Root writes cannot be clobbered by commit/rollback and uncommitted writes are isolated.
- Remote I/O and events remain outside transactions; publication follows commit.
- Ambiguous remote outcomes retain exact recovery material and owned resources.

Public APIs, package exports, persisted formats, and protocol behavior do not change with this
internal composition model. `CoreTransaction` and the runner remain internal implementation details.
