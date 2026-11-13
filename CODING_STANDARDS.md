# Coding standards

Apply core-specific contracts only to the packages and behavior they govern.
Use [CONTRIBUTING](CONTRIBUTING.md) for contribution workflow, commands and test organization.

## Scope the review

Apply the accepted design to new and substantially reworked flows. A narrow fix may retain a legacy
boundary when it avoids worsening that boundary and reports relevant deviations. Touching a file alone
does not require migrating its whole module. Follow the owning design's migration scope.

For domain changes, follow [domain routing](docs/agents/domain.md) for vocabulary and relevant ADRs.
Distinguish an accepted design from its implementation status: an ADR can constrain future work without
proving that a feature already exists. Resolve conflicts explicitly rather than copying a legacy example
or treating a stale comment as the contract.

## Package boundaries

- Persistence: put repository interfaces in `packages/core`, reusable SQL repositories and schema
  logic in `packages/sql-storage`, and runtime bindings in the matching adapter:
  `packages/indexeddb`, `packages/sqlite3`, `packages/sqlite-bun`, or `packages/expo-sqlite`.
- Put storage conformance helpers shared by adapters in `packages/adapter-tests`.
- New workspace packages with build-time dependencies on internal `@cashu/coco-*` packages must
  declare those dependencies as `peerDependencies`; the [root build](scripts/build.ts) derives package
  order from that graph.

## Keep responsibilities clear

Extract shared domain rules or meaningful responsibility boundaries. Similar-looking code alone does not
justify a generic framework. Keep related behavior together so a reader can follow the workflow and its
invariants without unnecessary indirection. Judge cohesion and navigation cost rather than file length,
class count or number of interfaces.

Thin public API facades are intentional. Internal abstractions should hide meaningful behavior or
constrain authority; a narrow interface can be useful even with one implementation. Check the concrete
dependencies and composition wiring to establish what a module can actually do.

### Transactions

These rules govern Wallet persistence, operation coordination and storage adapters in
`packages/core`. The decisions behind them are
[ADR-0011](packages/core/docs/adr/0011-compose-wallet-transactions-in-the-owning-coordinator.md) (coordinator-owned
transactions), [ADR-0018](packages/core/docs/adr/0018-release-operation-owned-value-only-on-positive-evidence.md)
(releasing owned value) and [ADR-0019](packages/core/docs/adr/0019-never-lower-or-reclaim-allocated-positions.md)
(allocated positions). This section holds rules that apply to every operation. The behavior of one
operation belongs in its code, comments and tests, not here.

| Role              | Does                                                                        | Must not                                                                   |
| ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Coordinator       | Orders preflight, `run()` calls, remote effects, recovery and events        | Mutate root repositories or retain a live scope                            |
| Transition        | Composes the local changes of one domain step inside the `tx` it is given   | Reach a runner, root repositories, coordinators, remote I/O or live events |
| Scoped capability | Holds reusable local rules, such as proof reservation and Output Allocation | Open a transaction or import workflow transitions                          |
| Query             | Reads state outside a transaction                                           | Initialize or repair storage, allocate, or commit                          |
| Handler or Remote | Performs remote I/O and returns candidate facts                             | Receive repositories, mutation services or an event bus                    |

Every workflow with a remote effect has this shape:

```text
preflight -> authorize in run() -> remote I/O -> apply in run() -> publish
```

- Only the outermost local workflow calls `transactionRunner.run()`. Never open a transaction
  inside one, accept an optional transaction argument that opens one when omitted, or keep `tx` or
  its capabilities after `run()` returns.
- For one atomic commit, compose transitions inside a single `run()`. Separate `run()` calls, and
  service entry points that commit on their own, are separate commits.
- Fix retry-sensitive inputs before `run()`: IDs, timestamps, randomness, the loaded Wallet Seed and
  method policy. The runner repeats the whole callback after a transient repository conflict.
- A `run()` callback does local work only. It must not close over remote clients, seed loaders,
  coordinators, timers, event buses, root repositories or another runner. TypeScript does not
  enforce this, so read the callback and its helpers.
- Repeat or validate inside the transaction every read that authorizes a mutation. Reads made in
  preflight are informational.
- Applying a remote result reloads the durable operation and checks that the result belongs to its
  persisted request.
- Work that writes and may then throw must be a `Transition`. A rejected transition fails the
  attempt even when its caller catches the rejection, so return expected outcomes as results such as
  `changed: false`.
- Await dependent capability calls sequentially. Lifetime tracking contains work but does not order
  it. Do not await unrelated asynchronous work inside a transaction: an IndexedDB transaction
  becomes inactive.
- Publish events only after `run()` returns. Transitions and capabilities return results and never
  emit. Delivery is best effort, and a listener failure neither undoes the commit nor replays a
  remote effect.
- In-memory locks reduce contention. Correctness comes from durable revisions or conditional
  transitions checked inside the transaction.
- A capability exists to hold a rule. Do not expose raw counters so that a workflow can rebuild
  allocation, and do not wrap a scoped repository in a class that only forwards.
- `CoreTransaction`, `Transition` and the runner stay out of package entry points.

Naming:

| Name                                           | Use                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `<Domain>Service` / `<Domain>OperationService` | Coordinator; the second also owns a durable operation lifecycle                              |
| `transactionRunner`, `work`, `tx`              | The injected runner, the callback it accepts, and the live scope                             |
| `<Domain>Transitions.ts`                       | One module per operation for its whole lifecycle, including recovery, beside its coordinator |
| `<Action>Input` / `<Action>Result`             | A transition's argument and result, without doubling a suffix: `ApplySendResultInput`        |
| `Scoped<Domain>` / `RepositoryScoped<Domain>`  | A capability and its repository-backed implementation, in one file under `transactions/`     |
| `<Domain>Queries`                              | Read-only state access outside a transaction                                                 |
| `<Domain>Remote` / `<Provider><Domain>Remote`  | A remote I/O boundary and its provider implementation                                        |
| `<Domain>Validation.ts`                        | Pure helpers, with no persistence or remote effects                                          |

Every runtime export of a `*Transitions.ts` or `*TransitionTypes.ts` module under `operations/` must
be a `Transition`; an export guard test enforces this. Name transitions with domain verbs
(`prepareSend`) and call them through `tx.perform(prepareSend, input)`. A `changed` flag reports a
local change, never that the outer transaction committed.

Before handoff of a change to Wallet persistence, operation coordination or adapters:

1. Name each module's role and trace what it can reach, including helpers and composition-root
   wiring.
2. Find the owning `run()` for each atomic change. Confirm that every participant uses its scope,
   authorizing reads happen inside it, and dependent calls are sequential.
3. Trace effects: preflight and remote I/O outside, inputs fixed before the callback, events after
   commit. A commit made by an independent workflow must be meant to survive the caller's failure.
4. Run the flow's behavior tests on memory and a persistent adapter; typecheck alone does not
   establish adherence. Report the transaction boundaries you inspected and any remaining deviation.

Change this section only when a rule changes, and record a changed decision in its ADR.

## Syntax and React conventions

- Prefer `import type` for type-only imports.
- Order imports as external, then internal or alias, then relative.
- In `packages/react`, use `useCallback` or `useMemo` when a value participates in dependencies.
- In `packages/react`, normalize unknown caught errors with
  `e instanceof Error ? e : new Error(String(e))`.

## Preserve domain meaning and compatibility

Validate inputs early; return empty arrays for no-op cases when appropriate to the contract. In core
and adapters, normalize mint URLs with `normalizeMintUrl()` before persistence. Check repository
mutations against their atomicity and invariant contracts under the transaction rules above.

Keep caller convenience at public boundaries and canonical domain representations internally. In core,
follow [amounts.ts](packages/core/amounts.ts) for public parsing and internal amount/unit contracts.
Preserve precision, unit provenance and intentional compatibility handling. Model distinctions that
change behavior explicitly in inputs, states and results. Keep any use of `any` tightly scoped and
justified.

Expose public APIs through the entry points declared in the package's `package.json`.
Review compatibility across the package's supported entry points, reachable public types, events and
persisted records. Core's [documented exports](packages/core/README.md#exports) include root, adapter and
plugin audiences; [ServiceMap](packages/core/plugins/types.ts) makes reachable plugin service contracts
compatibility-sensitive. An internal refactor can affect those contracts without changing root exports.

Apply the [repository compatibility policy](packages/core/README.md#repository-compatibility)
when reviewing changes to storage adapter contracts.

Preserve support for ordinary records written by older releases until an explicit migration or
breaking-change decision replaces it. Repairing an exceptional inconsistent state that an old
implementation might have produced is a separate decision. Assess severity, plausible likelihood,
existing recovery options, and the complexity or risk of the proposed fix. The small current userbase
informs likelihood; it does not establish that a state never occurred. Neither theoretical reachability
nor severity alone automatically requires a repair or blocks a change. Explain the assessment when it
affects the review outcome.

## Make failures and lifecycle guarantees deliberate

Use meaningful error categories where callers must distinguish rejection, retryable failure or an
uncertain remote outcome. In core and adapters, prefer the existing domain errors in
[Error.ts](packages/core/models/Error.ts). Preserve causes when wrapping failures. Ordinary errors are
appropriate for internal preconditions that need no separate caller behavior. Keep unavoidable message-matching
compatibility logic isolated and tested. Respect each flow's documented retry and recovery policy.

After an owner's `stop()` or `dispose()` resolves, it must not accept new work or leave subscriptions
and timers active. Account for resources acquired during shutdown and release late acquisition
results. Define and document whether already-started processing is drained or allowed to finish;
already-submitted remote requests may complete. Keep stopped runs from installing resources or
continuing discovery after a restart.

The proof-state watcher is the one documented exception to draining started work on shutdown; see
[ADR-0014](packages/core/docs/adr/0014-let-proof-watcher-shutdown-finish-started-work.md). It does
not change other owners' documented drain guarantees. Apply the incremental legacy policy above when
reviewing existing lifecycles.

Use structured diagnostic context. **Never log the seed returned by `seedGetter`**, including through
copies, cached values, encodings, object dumps or error context. This also applies to debug logging.

## Test behavior

Add or update tests with behavior changes whenever practical.
Name the public boundary that demonstrates the guarantee under change before writing the test, then
choose the first fit from this order:

1. The public surface (`Manager`, `ops.*`) against the real mint, in the integration suite. This is the
   default for workflows and interactions.
2. The same public surface with an in-process fake at a system boundary (transport, clock, storage
   failure), for failures, races and interrupted states a real mint cannot produce on demand. Use the
   real repositories and services behind the boundary.
3. A unit test, only for pure logic or a state-transition table.

Doubles must not remove the persistence, protocol or lifecycle behavior the test is meant to prove. Do
not mock Coco's own services or collaborators: such a test checks the mock, not the behavior. Avoid tests
that merely mirror implementation, read private fields, or repeat trivial delegation, and do not add
tests only to reach a coverage target.

Assert observable outcomes and relevant failure behavior. For recovery changes, exercise the historical
records or interrupted states that the change actually promises to handle, guided by the risk assessment
above. Keep tests deterministic and await asynchronous work explicitly; use controlled interleavings,
clocks or completion signals for races. Add persistent-adapter coverage when storage semantics matter;
do not require every backend or duplicate equivalent assertions
by default. Type-level contracts also need compiler verification.

Use the affected scripts and CI selection to establish what actually runs. A test's presence in a
directory is not evidence that a particular CI job executes it. Report exact verification commands and
results, including suites and storage backends exercised, relevant mint fee and unit configuration,
work left to CI, and any remaining uncertainty. Distinguish direct execution of a package's test entry
from running the integration runner's package matrix.

## Keep guidance accurate

Add JSDoc for public APIs and non-obvious flows. Comments should explain contracts, non-obvious
ordering, authority or compatibility decisions. Update affected public examples and API descriptions
with behavior or signature changes. Keep the reasoning
behind an architectural rule in its ADR and link to it here. Mechanical preferences belong in
configuration where practical; mixed local syntax is not evidence for an invented universal standard.

Tie review findings to a concrete affected behavior or agreed contract, with evidence and proportionate
severity. Distinguish required fixes from optional improvements and separately scoped legacy migrations.
