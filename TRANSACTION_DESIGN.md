# Transaction Design

Status: accepted
([ADR-0011](./packages/core/docs/adr/0011-use-domain-transaction-gateways.md))

## Purpose

Coco coordinates crash-safe Wallet mutations through one transaction runner per Coco Session.
The outermost local workflow owns the transaction. Transitions and capabilities participating in that
workflow receive the same short-lived scope and cannot open transactions themselves.

There are three responsibilities:

| Role              | Responsibility                                                       | Example                             |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------- |
| Coordinator       | Orders preflight, transactions, remote effects, recovery, and events | `SendOperationService`              |
| Transition        | Composes the local changes that form one domain transition           | `tx.perform(prepareSend, input)`    |
| Scoped capability | Encapsulates reusable local rules                                    | `tx.proofs.selectAndReserve(input)` |

`CoreTransactionRunner` owns scope construction, commit, rollback, and bounded retries. A
transition does not commit: its caller may compose additional work before returning.
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

A `Transition<I, O>` is an opaque, frozen value defined with `defineTransition`. It has no call
signature. Coordinators and other transition bodies execute it through `tx.perform(transition,
input)`. The scope's existing lifetime proxy tracks `perform` just like capability methods, so the
whole body is drained before commit. A thrown error or rejected promise fails the entire attempt
even if the caller catches the rejection. No per-transition tracking wrapper or scope registry is
required.

The runner closes `perform` over the bound `CoreTransaction`. This matters because the proxy invokes
methods with the raw source as their receiver: using that receiver as the body scope would let
capability methods escape lifetime tracking. A captured `tx.perform` rejects after its attempt ends.
The body accessor in `Transition.ts` is internal runner machinery; application code must use `perform`.

```ts
const prepareAndAuthorizeSwap = defineTransition(
  async (tx, input: { send: PrepareSendInput; updatedAt: number }) => {
    const prepared = await tx.perform(prepareSend, input.send);
    return tx.perform(beginSendExecution, {
      operationId: prepared.operation.id,
      updatedAt: input.updatedAt,
    });
  },
);
```

## Composition

A coordinator may compose scoped capabilities directly. Define a transition when the sequence
expresses a meaningful domain invariant or prevents duplication. Its body receives the full
`CoreTransaction`; nested transitions execute through that same scope's `perform` method. Neither
`defineTransition` nor `perform` opens another transaction.

Plain helper functions are not independently tracked. Any composable work that writes and may then
throw must be a `Transition`, so catching its rejection cannot commit partial work. Pure helpers may
remain ordinary functions. Private helpers awaited by a transition are covered when their errors
propagate out of its body; catching their own errors can hide failures from tracking. Return expected
outcomes as results, such as `changed: false`, instead of throwing: a transition rejection always
fails the attempt.

```ts
// A standalone transition.
const prepared = await transactionRunner.run((tx) => tx.perform(prepareSend, input));

// A larger local workflow, using the same implementation and adapter transaction.
const result = await transactionRunner.run(async (tx) => {
  const prepared = await tx.perform(prepareSend, input);
  const authorized = await tx.perform(beginSendExecution, executionInput);
  return { prepared, authorized };
});
// Remote execution can now use the committed authorization.
```

If the second transition fails, proof reservation, Output Allocation, and the prepared Send all
roll back. The outer callback owns the additional invariant connecting its transitions. Separate
`run()` calls are separate commits even when they use the same runner. For atomic composition,
reuse transitions, not service entry points that independently commit.

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
const authorization = await transactionRunner.run((tx) =>
  tx.perform(beginSendExecution, executionInput),
);
const remoteResult = await remote.execute(authorization.request);
const resultInput = prepareResultInput(authorization, remoteResult);
const result = await transactionRunner.run((tx) => tx.perform(applySendResult, resultInput));
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
Coordinator dependencies remain acyclic. Transitions and scoped capabilities never receive
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
`perform` methods reject further use. Tracking does not cancel arbitrary JavaScript promises
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

Events are published only after the owning `run()` returns. Scoped capabilities and transitions
return results rather than emitting live events. A failed transaction publishes nothing. Listener
failures are logged without turning a committed mutation into a failure or replaying a remote effect.
Delivery remains best effort: a crash between commit and publication can lose an event. An outbox
is separate future work.

## Mint Operations

`MintOperationService` receives the shared runner, read-only operation/proof queries, seed loading,
method handlers, and independent quote/metadata workflows. `tx.perform(prepareMint, input)` accepts
a fixed caller-supplied operation ID. It validates the canonical quote, trust, NUT-04 policy, quote-key
ownership, and active keys inside the transaction, then persists the pending operation with its
Output Allocation. New preparation does not persist an intermediate init row. Legacy init rows
remain readable and are cleaned up through a scoped transition.

`beginMintExecution` rechecks canonical quote accounting and sibling operations in the same scope
that records executing. This creates the Mint Quote Reservation; pending operations reserve no
balance. State checks and updates share the adapter's serialized write transaction, without relying
on an in-memory operation or quote lock for correctness. Standalone Mint preparation retains the
shared mint lock for compatibility with same-session legacy output allocators; their cross-session
counter safety remains part of the owning legacy migrations.

Protocol handlers receive remote dependencies and return candidate proofs. They never allocate
outputs or save proofs. Recovery records Quote Observations through the coordinator's independent
quote workflow before advancing from them. `applyMintResult` validates candidates against the exact
persisted output plan and atomically saves proofs and finalizes the operation. Existing saved proofs
retain their spend/reservation state. Local finalization does not fabricate remote quote accounting;
Claimability incorporates finalized local issuance using the existing maximum rule.

Unresolved execution, invalid responses, and incomplete proof recovery retain executing and its
reservation. Only a definitive non-issuance result permits failure. Recovery and initial execution
share settlement. Events follow commit, and listener failures do not replay issuance. Repositories
preserve coordinator-supplied timestamps, subject to existing adapter precision.

The dormant Mint Swap coordinator calls `tx.perform(prepareMint, destinationInput)` with its
predetermined child ID and compose additional local transitions before returning. Its remote quote creation and
metadata/seed preflight still occur outside the transaction. Melt supplies the corresponding source
side through `prepareMelt`.

## Melt Operations

`MeltOperationService` receives the shared runner, read-only operation/proof queries, seed loading,
remote-only method handlers, and independent quote/metadata workflows. `prepareMelt` validates the
canonical quote, trust, NUT-05 policy, active keys, and unit inside the transaction. It atomically
reserves exact input proofs, allocates the blank NUT-08 change plan and optional pre-swap plan,
advances their counter positions, and persists the prepared operation. New preparation creates no
intermediate `init` row; `cleanupMeltInit` exists only for legacy recovery.

`beginMeltExecution` atomically records `executing` and marks the exact original inputs inflight.
That commit authorizes the first remote effect: NUT-05 directly, or NUT-03 for a pre-swap. A
successful pre-swap is passed to `applyMeltSwapResult`, which atomically spends the original inputs,
saves keep proofs ready, and saves the exact Melt inputs inflight before NUT-05 is submitted. This
local checkpoint is required because the two remote calls cannot share a Wallet transaction.

Handlers create/fetch quotes, perform the pre-swap, and submit Melt requests. They receive no Wallet
repositories, mutation Services, or event bus and return candidate facts only. The coordinator
records each remote quote observation before calling `applyMeltPending`, `applyMeltPaidResult`, or
`releaseMeltAfterNonPayment`. Paid settlement validates NUT-08 change against the persisted output
plan and atomically saves change, spends the exact Melt inputs, and finalizes the operation.

Only fresh positive `UNPAID` evidence permits release. Prepared cancellation is safe because no
remote effect was authorized. Timeouts, transport errors, malformed responses, incomplete pre-swap
restoration, and contradictory proof/quote observations retain operation-owned value and use
`deferMeltRecovery`. Recovery restores remote output candidates outside transactions, then passes
them through the same result transitions as initial execution. Repositories preserve the
coordinator-supplied timestamp, subject to adapter precision.

A Mint Swap parent can compose predetermined `prepareMelt` and `prepareMint` child IDs in one runner
callback. If later parent work fails, both child operations, Melt proof reservation, and all output
counter changes roll back together. Their remote effects still occur only after that parent commit.

## Mint Swap Operations

The internal `MintSwapOperationService` composes the existing Mint and Melt transitions with
branded parent transitions. Opt-in `tx.mintSwapOperations` is bound to the same adapter transaction.
Memory stores opt in with `new MemoryRepositories({ mintSwap: true })`; persistent adapters retain
their existing opt-in capability and schema. The coordinator is not wired into Manager or public APIs.

Locked destination quote creation follows an independent committed NUT-20 key allocation. Quote
creation and metadata refresh intentionally survive later preparation failure. Parent preparation
commits both exact child plans, source proof reservation, counter allocations, debit bounds, and the
parent checkpoint together. Source and destination authorization compose their child transitions
with parent progress; only a newly changed authorization permits initial remote dispatch.

Source recovery observes before acting and never blindly repeats a payment. A pre-swap result must
commit before NUT-05. Quote Observations commit before child settlement and parent reconciliation.
Destination proof settlement does not invent remote issued accounting: the parent stays pending
until canonical accounting and exact stored proofs agree. Contradictory parent accounting preserves
a valid committed child settlement and records needs_attention. Ambiguous outcomes retain recovery
material and persist bounded retry scheduling.

One effect-driving Coco Session per Wallet store is required. Shared child operation locks coordinate
ordinary child services with the parent; parent revisions do not fence network effects across
independent sessions. Runtime enforcement and activation belong to #419. Child change snapshots are
captured within each attempt and published after commit and lock release, so reentrant listeners
cannot deadlock on the coordinator's child locks. Delivery remains best effort, without an outbox.

## Files and Dependencies

```text
operations/send/
  SendOperationService.ts                     # workflow orchestration
  SendTransitions.ts                         # complete Send lifecycle, including recovery
  SendTransitionTypes.ts                     # named transition inputs and results
  SendValidation.ts                          # pure validation and comparison helpers
operations/mint/
  MintOperationService.ts                     # workflow orchestration
  MintTransitions.ts                         # preparation, issuance, settlement, and recovery
  MintTransitionTypes.ts                     # named Mint transition inputs and results
operations/melt/
  MeltOperationService.ts                    # Melt saga coordinator
  MeltTransitions.ts                         # reservation, authorization, settlement, and recovery
  MeltTransitionTypes.ts                     # named Melt transition inputs and results
services/KeyRingService.ts                    # key management orchestration
transactions/
  CoreTransaction.ts                         # scope, runner interface, implementation
  TransactionLifetime.ts                     # internal containment mechanism
  Transition.ts                              # opaque brand, definition, runner-only body access
  proofs/ScopedProofs.ts                      # shared proof rules and scoped persistence
  outputs/ScopedOutputs.ts                    # output allocation including counters
  keypairs/ScopedKeypairs.ts                  # keypair allocation and scoped persistence
  mints/ScopedMintMetadata.ts                 # metadata application and trust checks
```

Names describe authority and lifetime:

| Name                                           | Role                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `<Domain>Service` / `<Domain>OperationService` | Orchestrates preflight, local transactions, remote effects, and events.                               |
| `<Domain>Operation`                            | Durable saga state that survives individual transactions.                                             |
| `CoreTransaction`                              | Live scope for one transaction attempt, passed as `tx`.                                               |
| `Transition<I, O>`                             | Opaque local work, defined with `defineTransition` and executed through `tx.perform`.                 |
| `CoreTransactionRunner`                        | Opens and completes transactions; injected as `transactionRunner`.                                    |
| `Scoped<Domain>`                               | Local reads and mutations bound to an existing transaction, such as `ScopedProofs`.                   |
| `RepositoryScoped<Domain>`                     | Its repository-backed implementation, colocated with the interface.                                   |
| `<Domain>Transitions.ts`                       | Branded transition values whose bodies compose local mutations within a supplied `tx`.                |
| `<Action>Input` / `<Action>Result`             | Arguments and results named after the transition, such as `PrepareSendInput` and `PrepareSendResult`. |
| `<Domain>Queries`                              | Read-only queries outside a transaction; a repository may implement the interface directly.           |
| `<Domain>Remote` / `<Provider><Domain>Remote`  | Remote I/O boundary and its provider implementation.                                                  |
| `<Domain>Validation.ts`                        | Pure validation helpers with no persistence or remote effects.                                        |

Keep `CoreTransaction`, `CoreTransactionRunner`, and `RepositoryCoreTransactionRunner` together in
`CoreTransaction.ts`: they describe and implement the same boundary. Keep each capability interface
and implementation together too. Reserve transaction terminology for the runner, live scope, and
lifetime machinery. Use `Scoped<Domain>` and `RepositoryScoped<Domain>` for reusable capabilities
bound to an existing transaction. Their methods include reads and mutations but never open or commit
a transaction. `Transition` names the domain change performed within that scope; one transaction may
compose several transitions.

Workflow transitions live alongside their operation code under `operations/<domain>/`, with their
named input and result types in `<Domain>TransitionTypes.ts`. This keeps domain behavior with its
lifecycle while `transactions/` contains the shared transaction machinery and scoped implementations.
Start with one `<Domain>Transitions.ts` module for the complete lifecycle. In Send, order functions by
preparation, execution, completion, cancellation and reclaim, then recovery. Recovery reuses the same lifecycle
transitions, so its entry point does not determine a separate module boundary. Extract a smaller
`*Transitions.ts` module only when a cohesive responsibility warrants it; splitting by phase or by
individual transition is optional. Every runtime export from `*Transitions.ts` and
`*TransitionTypes.ts` modules under `operations/` must be a branded `Transition`; an export guard test
enforces this. Type-only exports are allowed. Exported pure helpers live in separate modules alongside
the transitions, such as `operations/send/SendValidation.ts`.

Transition values use domain verbs such as `prepareSend`, called through `tx.perform(prepareSend, input)`. Capability methods use short
verbs such as `tx.proofs.selectAndReserve(input)`. Prefer private helpers when only one module needs
them. Name shared helper and type files for their domain instead of generic `types.ts`, `inputs.ts`,
or `helpers.ts` files.

Transition input objects use the parameter `input`; the callback accepted by the runner is named `work`.
Use `Transition<void, O>` for no-input work and call `tx.perform(transition)` without a second argument.
An id-only transition may take a bare string: `tx.perform(cleanupLegacySendInit, operationId)`.
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
  tx.perform(applySendResult, { operationId, updatedAt, keepProofs, sendProofs, token }),
);
if (result.changed) await publish(result);
```

Shared capabilities must never import workflow transitions. Transitions may compose capabilities
and other local transitions, but cannot import a runner or acquire transaction-opening authority.

| Module                             | Allowed dependencies                                                                                      | Forbidden authority                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Coordinator                        | Runner, transitions, Queries, local capabilities, remote interfaces, events, narrow independent workflows | Root repository mutation, retaining live scopes                                 |
| Transition                         | Supplied scope, other transitions via `tx.perform`, pure helpers                                          | Runner, body accessor, root repositories, coordinators, remote I/O, live events |
| Scoped capability                  | Scoped repositories, peer capabilities, pure helpers                                                      | Transaction openers, root repositories, coordinators, remote I/O, live events   |
| Query / local preflight capability | Read-only state interfaces, pure helpers, explicit local inputs                                           | Persistence mutation, transaction openers, remote I/O, live events              |
| Runner / composition root          | Root repositories, adapters, scoped constructors, transition body accessor, lifetime mechanism            | Workflow orchestration and remote effects inside attempts                       |

Scoped implementations import repository contracts with `import type`. Follow the authority actually
supplied through imported helpers and injected implementations; narrow types alone do not establish
purity. Use code review, scoped types, behavior tests, and the transition export guard together.

## Agent Review

Before completing a change involving Wallet persistence, operation coordination, or adapters:

1. Identify each module's role and trace its dependencies, including helpers and composition-root
   wiring. Coordinators receive the shared runner; transitions and capabilities cannot open one.
2. Identify the owning `run()` for each atomic transition. Check that all participants use its scope,
   authoritative reads occur inside it, and dependent capability calls are sequential. Examine any concurrent
   group for safe interleaving.
3. Trace effects: asynchronous preflight and remote work outside, synchronous derivation inside,
   retry-sensitive inputs fixed before the callback, and events after commit. Independent workflow
   commits must intentionally survive caller failure and complete outside the caller's transaction.
4. Verify that transition bodies receive the bound scope and callers use `tx.perform`. Check failure
   rollback, nested composition, dropped promises, and expired method rejection. Run relevant behavior tests; typecheck alone does not establish adherence.
5. Report inspected transaction boundaries, verification, and remaining legacy deviations. Update this
   design and ADR-0011 together when changing the contract.

## Migration and Verification

Send, Mint, Melt, and the dormant Mint Swap coordinator, KeyRing mutations, and mint metadata refresh use coordinator-owned transactions.
Legacy Receive, legacy public Mint Swap orchestration, Payment Request Receive parent/attempt/child
atomicity, and MintService add/forced-update/trust/delete paths remain for their owning migrations.
Those migrations should reuse domain capabilities and branded transitions, rather than add domain gateways.
Runtime rejection of nested Wallet transactions remains nonuniform: IndexedDB rejects ambient
transactions, while Memory/SQLite root calls may queue behind an outer caller awaiting them. Do not
rely on a universal runtime guard; distinguishing nesting from legitimate concurrency remains work.

Behavior tests cover memory and persistent adapters:

- Standalone and composed transitions use the same implementations and one transaction per attempt.
- Grouped proof, counter, operation, and keypair changes commit together or all roll back.
- A composed transition's validation failure rolls back earlier successful work, even if caught.
- Dropped `perform` promises drain fully; finished scopes and captured methods reject later calls.
- Failed concurrent work drains before rollback/retry and cannot continue in a later attempt.
- Retried workflows preserve stable inputs and allocate only once in the committed attempt.
- Authoritative reservation and revision checks choose one concurrent winner.
- Root writes cannot be clobbered by commit/rollback and uncommitted writes are isolated.
- Remote I/O and events remain outside transactions; publication follows commit.
- Ambiguous remote outcomes retain exact recovery material and owned resources.

Public APIs, package exports, persisted formats, and protocol behavior do not change with this
internal composition model. `CoreTransaction`, `Transition`, their helpers, and the runner remain internal implementation details.
They must not be exported from package entry points.
