---
status: accepted
---

# Use domain transaction gateways for critical Wallet mutations

Coco uses narrow domain transaction gateways backed by one composition-root-owned runner for
critical Wallet mutations. Services coordinate domain management actions; Operation Services
additionally coordinate durable saga lifecycles. Both use domain gateways, while shared scoped
commands compose reusable domain invariants within one adapter transaction. Each gateway method
returns only after commit, with the runner owning rollback and bounded retries.

This gives each atomic transition an explicit owner and prevents reusable helpers from opening
nested transactions. Coordinators perform asynchronous preflight and remote mint I/O outside the
transaction and publish live events after commit. Authoritative reads and writes share the
transaction scope, preserving atomicity across supported adapters, including IndexedDB.

`Scoped*Commands` names interfaces for state-changing actions within an existing transaction.
Method-specific argument objects use `*Input` types and the parameter name `input`; transaction
runner callbacks are named `work`. These names distinguish actions from their inputs and the work
that composes them.

## Considered Options

Broad Service dependencies and transaction-scoped Service clones obscure effects and transaction
ownership. Composing separate gateway calls cannot provide one atomic transition. Shared scoped
commands preserve algorithm reuse while keeping transaction creation at the owning gateway.

We use agent and human review, scoped types, and behavior tests instead of a custom architecture
checker because partial static analysis adds maintenance cost without establishing effect safety.

## Consequences

The design adds interfaces and stricter dependency boundaries. Adoption is incremental: Keypair
Allocation establishes the baseline, and other workflows migrate through their own gateways while
reusing shared scoped commands.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) is the authoritative implementation
contract for naming, dependencies, scope lifetime, concurrency, retries, and review requirements.
