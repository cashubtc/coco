---
status: accepted
---

# Compose Wallet transactions in the owning coordinator

Coco injects one session-scoped `CoreTransactionRunner` into application coordinators. The outermost
local workflow calls `run()` and composes domain capabilities and reusable transaction functions within
its supplied `CoreTransaction`. Functions such as `prepareSend(tx, input)` never open or
commit a transaction; they can serve standalone callers and larger atomic workflows unchanged.

This revises the original decision to require domain transaction gateways. Mirrored gateway and
scoped workflow interfaces added forwarding layers and made cross-domain composition unnecessarily
indirect. The runner now owns commit, rollback, retries, and scope lifetime; the coordinator chooses
the atomic write set, and reusable capabilities/functions own its domain invariants. No per-workflow
scope type or gateway is required. Scoped repository contracts may directly provide narrow local
persistence capabilities when another wrapper would add no behavior.

## Considered Options

Mandatory gateways provided an explicit committed-result interface but duplicated every transition
and prevented coordinators from directly composing local work. Broad transaction-scoped service
clones and optional transaction parameters obscure lifetime and transaction ownership. Composing
independent service calls cannot produce one atomic commit. We instead compose local functions
through a mandatory shared scope and keep service entry points outside transaction callbacks.

## Naming and Organization

`CoreTransaction.ts` contains the live scope, runner interface, and repository-backed runner. Inject
it as `transactionRunner` and name its callback scope `tx`. Shared scoped capabilities use
`Transaction<Domain>` and `RepositoryTransaction<Domain>`, with interface and implementation in the
same file. These capabilities include reads, so `Commands` does not describe their role accurately.

Reusable workflow functions live in `transactions/transitions/<domain>/`. Start with one
`<Domain>Transitions.ts` module containing the complete lifecycle. Send keeps preparation, execution,
completion, cancellation, reclaim, and recovery together in `SendTransitions.ts`, with shared types
in `SendTransitionTypes.ts` and pure helpers in `SendValidation.ts`. Recovery reuses the same
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

Extracted transaction functions enroll their work in the existing lifetime through the internal
`trackTransactionWork` helper. It neither opens nor commits transactions. This preserves failure
containment and expired-scope rejection when functions replace scoped workflow classes.

Independently committed actions such as `MintService.refreshAndCommitIfStale` remain reusable outside
transactions. Their commits intentionally survive later caller failure. Only applied metadata
observations publish events; older observations and timestamp ties retain the first committed
snapshot. Coordinator dependencies remain acyclic.

Send, Mint, KeyRing, and mint metadata refresh use this model. Mint preparation persists its
caller-chosen operation ID, deterministic output plan, and counter allocation together. Issuance
checks quote balance against sibling operations in the transaction that reserves it; settlement
saves exact proofs and finalizes together. Protocol handlers return candidates without persistence.
Ambiguous outcomes retain executing and its reservation, and finalized local issuance does not
fabricate remote Quote Observations. This makes the Mint transition reusable by a future Mint Swap
parent while Melt and Mint Swap orchestration remain separate migrations. Repositories preserve the
coordinator's retry-stable timestamp, subject to their existing precision. Other legacy workflows
migrate separately.
Consistent fail-fast rejection of nested transactions remains follow-up work and must distinguish
nesting from legitimate concurrent calls. There are no public API or persisted-format changes.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) defines the implementation and review contract.
