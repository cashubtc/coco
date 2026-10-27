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
it as `transactionRunner` and name its callback scope `tx`. Reserve transaction terminology for the
runner, live scope, and lifetime machinery. Shared capabilities use `Scoped<Domain>` and
`RepositoryScoped<Domain>`, with interface and implementation in the same file. `Scoped` describes
their binding to an existing transaction: their methods include reads and mutations but never open
or commit a transaction. A transition expresses a domain change within that scope, and several
transitions may share one transaction.

Branded workflow transitions live alongside their operation code in `operations/<domain>/`.
`transactions/` contains the shared transaction machinery and scoped implementations. Start with one
`<Domain>Transitions.ts` module containing the complete lifecycle. Send keeps preparation, execution,
completion, cancellation, reclaim, and recovery together in `operations/send/SendTransitions.ts`,
with `SendTransitionTypes.ts` and `SendValidation.ts` alongside it. Recovery reuses the same
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

Every runtime export from `*Transitions.ts` and `*TransitionTypes.ts` under `operations/` must be a
`Transition`, enforced by an export guard test. Exported pure helpers live in separate modules
alongside the transitions. No-input transitions use `void` and
`tx.perform(transition)`; id-only transitions may accept a bare string. The brand and internal body
accessor remain in `transactions/Transition.ts` and stay out of package entry points.

Independently committed actions such as `MintService.refreshAndCommitIfStale` remain reusable outside
transactions. Their commits intentionally survive later caller failure. Only applied metadata
observations publish events; older observations and timestamp ties retain the first committed
snapshot. Coordinator dependencies remain acyclic.

Mint Swap persistence is a required part of every Wallet transaction scope. Adapter migrations
govern persisted model changes. Funded Mint Swap redemption derives
authority from the persisted paid parent and exact child, quote, and proof evidence checked in the
same scope as the Mint Quote Reservation. It can recover paid value after trust revocation; ordinary
Mint execution retains its trust gate. Both paths compose the same reservation transition and exact-output settlement.
Mint Swap checks both mints' trust during initial source authorization in the owning transaction.
After that commit, trust revocation cannot interrupt the authorized request or its reconciliation:
source payment may have succeeded before its observation was persisted. Recovery retains all exact
request and ownership checks, never restores trust, and never blindly redispatches source payment.

Send, Mint, Melt, Receive, the Mint Swap coordinator, KeyRing, and mint metadata refresh use this model.
Mint Swap composes exact child preparation, authorization, and settlement through the same runner
scope. Manager shares its child locks with ordinary Mint/Melt services in one effect-driving Coco
Session per Wallet store. Existing host/session guards retain their scope; Core does not add a
universal cross-process singleton. Coco packages are intended to be used with lock-step versioning,
so the Mint Swap API has no feature activation gate. Initial source payment requires an explicit
`execute` call. The parent processor is enabled by default and can be disabled without restricting
explicit commands. It registers interests in the existing Mint/Melt watchers and consumes committed
canonical quote updates without initiating prepared source payment. Interests are rebuilt independently
of durable retry deadlines. Ordinary and parent interests are synchronous local declarations;
watchers own asynchronous activation, diagnostics, and late cleanup. Parent scans and replacement
declarations do not await retired physical cleanup, but stop drains it. Withdrawal immediately revokes
logical ownership while preserving shared owners. A disabled watcher does not recruit a replacement
parent quote poller. Startup uses sufficient cached evidence first, retaining a bounded recovery
fallback for unresolved evidence until #559 separates startup repair. Explicit recovery and necessary
recovery effects remain available. Source proof release
still requires fresh positive `UNPAID` confirmation under the shared child lock. Authorized recovery
interests permit observation of exact quotes after trust revocation, without restoring mint trust.
Parent update hints are captured in the owning transaction and published after commit and
lock release; local polling and complete active sweeps tolerate lost hints. No outbox or new schema
is introduced. Manager orders pause/resume changes and drains admitted lifecycle and parent work on
disposal. An observation timeout only ends waiting; it does not change the persisted operation.
Payment Request Receive parent/attempt/child atomicity and MintService
add/forced-update/trust/delete paths remain for their
owning migrations.
Consistent fail-fast rejection of nested transactions remains follow-up work and must distinguish
nesting from legitimate concurrent calls. Mint Swap runtime adds public APIs/configuration/events;
it does not change the persisted parent format.

The Restore migration adds an explicit exception
to the public API compatibility policy: move Restore directly to scoped monotonic advancement and
remove plugin-facing `overwriteCounter()`, without first reworking CounterService. After migrating
the remaining legacy output allocators, remove CounterService and its plugin-facing entry. Until
those callers migrate, Restore's scoped advancement alone cannot prevent their stale counter writes
or make their output derivation and later counter increment one atomic Output Allocation. Receive now
owns transactional Output Allocation, and Sweep delegates exchanges through its coordinator methods.
The legacy plugin-facing allocation helpers remain outside that migration.

Restore commits proof import and counter advancement together per keyset. Its coordinator opens
one transaction, and a branded transition composes ScopedProofs and ScopedOutputs within that scope.
Remote discovery precedes the transaction and events follow commit; no nested transaction or new
durable operation is required. Failure in one keyset does not roll back previously committed keysets.
Restore applies discoveries additively, preserving local records absent from the scan and rejecting
conflicting proof identity. A proof-count comparison cannot establish completeness and is removed.
Only actual committed insertions, state changes, and counter advances publish update events.

[ADR-0012](0012-distinguish-mint-held-pending-proofs.md) additionally accepts a local `pending` proof
state for Restore. This is an explicit proof-state format and public type extension; it does not
change the single-scope transaction composition model.

Initial pending-proof reconciliation happens through repeated Restore, inside its keyset transaction.
Automatic pending-proof watching and its lifecycle changes are deferred to a separate migration.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) defines the implementation and review contract.
