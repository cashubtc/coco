---
status: accepted
---

# Compose Wallet transactions in the owning coordinator

Coco injects one session-scoped `CoreTransactionRunner` into application coordinators. The outermost
local workflow calls `run()` and composes domain commands and reusable transaction functions within
its supplied `CoreTransaction`. Functions such as `prepareSend(transaction, input)` never open or
commit a transaction; they can serve standalone callers and larger atomic workflows unchanged.

This revises the original decision to require domain transaction gateways. Mirrored gateway and
scoped workflow interfaces added forwarding layers and made cross-domain composition unnecessarily
indirect. The runner now owns commit, rollback, retries, and scope lifetime; the coordinator chooses
the atomic write set, and reusable commands/functions own its domain invariants. No per-workflow
scope type or gateway is required. Scoped repository contracts may directly provide narrow local
persistence capabilities when another wrapper would add no behavior.

## Considered Options

Mandatory gateways provided an explicit committed-result interface but duplicated every transition
and prevented coordinators from directly composing local work. Broad transaction-scoped service
clones and optional transaction parameters obscure lifetime and transaction ownership. Composing
independent service calls cannot produce one atomic commit. We instead compose local functions
through a mandatory shared scope and keep service entry points outside transaction callbacks.

## Consequences

Coordinator callbacks have more authority, so review must check their actual effects and captured
dependencies. Preflight and remote I/O stay outside transactions; retry-sensitive inputs are fixed
before callbacks; authoritative checks and mutations share one adapter scope; events follow commit.
Shared proof reservation, Output Allocation, and Keypair Allocation commands preserve their rules.

Extracted transaction functions enroll their work in the existing lifetime through the internal
`trackTransactionWork` helper. It neither opens nor commits transactions. This preserves failure
containment and expired-scope rejection when functions replace scoped workflow classes.

Independently committed actions such as `MintService.refreshAndCommitIfStale` remain reusable outside
transactions. Their commits intentionally survive later caller failure. Only applied metadata
observations publish events; older observations and timestamp ties retain the first committed
snapshot. Coordinator dependencies remain acyclic.

Send, KeyRing, and mint metadata refresh use this model. Other legacy workflows migrate separately.
Consistent fail-fast rejection of nested transactions remains follow-up work and must distinguish
nesting from legitimate concurrent calls. There are no public API or persisted-format changes.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) defines the implementation and review contract.
