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

Before changing or reviewing Wallet persistence, operation coordination or storage adapters, read
[TRANSACTION_DESIGN](TRANSACTION_DESIGN.md) and
[ADR-0011](packages/core/docs/adr/0011-use-domain-transaction-gateways.md). Before handoff, complete every
[Agent Review step](TRANSACTION_DESIGN.md#agent-review).

## Syntax and React conventions

- Prefer `import type` for type-only imports.
- Order imports as external, then internal or alias, then relative.
- In `packages/react`, use `useCallback` or `useMemo` when a value participates in dependencies.
- In `packages/react`, normalize unknown caught errors with
  `e instanceof Error ? e : new Error(String(e))`.

## Preserve domain meaning and compatibility

Validate inputs early; return empty arrays for no-op cases when appropriate to the contract. In core
and adapters, normalize mint URLs with `normalizeMintUrl()` before persistence. Check repository
mutations against their atomicity and invariant contracts under the transaction design above.

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

After an owner's `stop()` or `dispose()` resolves, it must not start new owned work or deliver late
callbacks. Account for resources acquired while shutdown is awaiting other work, release those
resources, and await owned work where necessary to establish the guarantee. Already-submitted remote
requests may complete. Define pause/resume separately from final shutdown. Apply the incremental legacy
policy above when reviewing existing lifecycle implementations.

Use structured diagnostic context. **Never log the seed returned by `seedGetter`**, including through
copies, cached values, encodings, object dumps or error context. This also applies to debug logging.

## Test behavior

Add or update tests with behavior changes whenever practical.
Prefer real behavior tests, especially the integration suite, for workflows and interactions. Focused
unit tests are valuable for complex behavior. Choose the boundary that demonstrates the guarantee under
change; doubles must not remove the persistence, protocol or lifecycle behavior the test is meant to
prove. Avoid tests that merely mirror implementation or repeat trivial delegation.

Assert observable outcomes and relevant failure behavior. For recovery changes, exercise the historical
records or interrupted states that the change actually promises to handle, guided by the risk assessment
above. Keep tests deterministic and await asynchronous work explicitly; use controlled interleavings,
clocks or completion signals for races. Add persistent-adapter coverage when storage semantics matter;
do not require every backend or duplicate equivalent assertions
by default. Type-level contracts also need compiler verification.

Use the affected scripts and CI selection to establish what actually runs. A test's presence in a
directory is not evidence that a particular CI job executes it. Report relevant verification and any
remaining uncertainty.

## Keep guidance accurate

Add JSDoc for public APIs and non-obvious flows. Comments should explain contracts, non-obvious
ordering, authority or compatibility decisions. Update affected public examples and API descriptions
with behavior or signature changes. Keep each detailed
architectural rule in its owning design or ADR and link to it here. Mechanical preferences belong in
configuration where practical; mixed local syntax is not evidence for an invented universal standard.

Tie review findings to a concrete affected behavior or agreed contract, with evidence and proportionate
severity. Distinguish required fixes from optional improvements and separately scoped legacy migrations.
