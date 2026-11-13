---
status: accepted
---

# Compose Wallet transactions in the owning coordinator

Coco injects one session-scoped `CoreTransactionRunner` into application coordinators. The outermost
local workflow calls `run()` and composes Scoped capabilities and reusable transitions within the
`CoreTransaction` it is given. A transition runs only through `tx.perform(transition, input)` and
never opens or commits a transaction, so the same transition serves a standalone caller and a larger
atomic workflow unchanged.

The runner owns commit, rollback, retries and scope lifetime. The coordinator chooses the atomic
write set. Capabilities and transitions own their domain invariants. Preflight and remote I/O stay
outside transactions, authoritative checks and mutations share one adapter scope, and events follow
commit.

A transition is an opaque, frozen value created with `defineTransition`, with no call signature.
The scope's lifetime tracks `tx.perform`, so the whole body settles before commit, including nested
transitions and dropped promises, and a transition that rejects fails the attempt even if its caller
catches the rejection.

Independently committed actions such as `MintService.refreshAndCommitIfStale` stay reusable outside
transactions. Their commits intentionally survive a later caller failure.

## Considered Options

- **Domain transaction gateways with mirrored scoped workflow interfaces.** Accepted first, then
  replaced by this decision. Gateways gave an explicit committed-result interface, but duplicated
  every transition behind a forwarding layer and stopped coordinators from composing local work
  across domains.
- **Transaction-scoped service clones or optional transaction parameters.** Rejected because they
  obscure the scope's lifetime and which caller owns the transaction.
- **Composing service calls that each commit.** Rejected because it cannot produce one atomic
  commit.
- **Callable transition functions, each wrapped for tracking.** Rejected because every function
  needed its own wrapper and a scope-to-lifetime registry. An opaque value performed through the
  scope is tracked once.

## Consequences

Coordinator callbacks have more authority, and TypeScript cannot prove that a callback is free of
remote I/O or captured dependencies, so review must check its actual effects. The rules, naming
conventions and review checklist that follow from this decision are in
[CODING_STANDARDS](../../../../CODING_STANDARDS.md#transactions).

Nested transactions are unsupported, and adapters do not reject nesting uniformly at runtime.
`CoreTransaction`, `Transition` and the runner are internal and stay out of package entry points.
