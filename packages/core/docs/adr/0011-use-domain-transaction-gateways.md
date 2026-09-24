---
status: accepted
---

# Compose Wallet transactions in the owning coordinator

Coco injects one session-scoped `CoreTransactionRunner` into application coordinators. The outermost
local workflow calls `run()` and composes domain capabilities and reusable transitions within
its supplied `CoreTransaction`. Transitions performed through `tx.perform(prepareSend, input)` never open or
commit a transaction; they can serve standalone callers and larger atomic workflows unchanged.

This revises the original decision to require domain transaction gateways. Mirrored gateway and
scoped workflow interfaces added forwarding layers and made cross-domain composition unnecessarily
indirect. The runner now owns commit, rollback, retries, and scope lifetime; the coordinator chooses
the atomic write set, and reusable capabilities/transitions own its domain invariants. No per-workflow
scope type or gateway is required. Scoped repository contracts may directly provide narrow local
persistence capabilities when another wrapper would add no behavior.

## Considered Options

Mandatory gateways provided an explicit committed-result interface but duplicated every transition
and prevented coordinators from directly composing local work. Broad transaction-scoped service
clones and optional transaction parameters obscure lifetime and transaction ownership. Composing
independent service calls cannot produce one atomic commit. We instead compose local transitions
through a mandatory shared scope and keep service entry points outside transaction callbacks.

## Naming and Organization

`CoreTransaction.ts` contains the live scope, runner interface, and repository-backed runner. Inject
it as `transactionRunner` and name its callback scope `tx`. Shared scoped capabilities use
`Transaction<Domain>` and `RepositoryTransaction<Domain>`, with interface and implementation in the
same file. These capabilities include reads, so `Commands` does not describe their role accurately.

Branded workflow transitions live in `transactions/transitions/<domain>/`. Start with one
`<Domain>Transitions.ts` module containing the complete lifecycle. Send keeps preparation, execution,
completion, cancellation, reclaim, and recovery together in `SendTransitions.ts`, with shared types
in `SendTransitionTypes.ts` and pure helpers in `operations/send/SendValidation.ts`. Recovery reuses the same
transitions. Smaller transition modules are optional and need a cohesive responsibility to justify
the split. Capabilities never depend on workflow transitions.

Inputs and results use action names with `Input` and `Result` suffixes, without repeating a suffix
already present in the action name. Result flags describe local changes (`changed`), not commit.
Inline input objects are encouraged; only preflight and retry-sensitive values need hoisting.

## Consequences

Coordinator callbacks have more authority, so review must check their actual effects and captured
dependencies. Preflight and remote I/O stay outside transactions; retry-sensitive inputs are fixed
before callbacks; authoritative checks and mutations share one adapter scope; events follow commit.
Shared proof reservation, Output Allocation, and Keypair Allocation capabilities preserve their rules.

Transitions are opaque, frozen values created with `defineTransition`, with no call signature.
`tx.perform(transition, input)` is the only application invocation path. The existing lifetime proxy
tracks this method, covering the entire body, including nested transitions and dropped promises.
The runner closes it over the bound scope because proxy method receivers are the unbound source;
transition bodies must retain tracked capability access. Captured `perform` methods expire with the
attempt. This removes the need for per-function wrappers and a scope-to-lifetime registry.

Plain helpers are not independently tracked. Composable work that writes and then may throw must
be a `Transition`. Private helper errors must propagate to the enclosing transition to fail its
attempt. Expected outcomes use results such as `changed`, because a transition rejection fails the
whole attempt even if its caller catches it. Bodies receive the full `CoreTransaction`.

Every runtime export under `transactions/transitions/` must be a `Transition`, enforced by an export
guard test. Exported pure helpers live outside that directory. No-input transitions use `void` and
`tx.perform(transition)`; id-only transitions may accept a bare string. The brand and internal body
accessor live in `Transition.ts`, outside the workflow directory, and stay out of package entry points.

Independently committed actions such as `MintService.refreshAndCommitIfStale` remain reusable outside
transactions. Their commits intentionally survive later caller failure. Only applied metadata
observations publish events; older observations and timestamp ties retain the first committed
snapshot. Coordinator dependencies remain acyclic.

Send, KeyRing, and mint metadata refresh use this model. Other legacy workflows migrate separately.
Consistent fail-fast rejection of nested transactions remains follow-up work and must distinguish
nesting from legitimate concurrent calls. There are no public API or persisted-format changes.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) defines the implementation and review contract.
