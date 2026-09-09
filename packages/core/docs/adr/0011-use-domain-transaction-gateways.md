---
status: accepted
---

# Use domain transaction gateways for critical Wallet mutations

Coco uses narrow domain transaction gateways backed by one composition-root-owned runner for
critical Wallet mutations. Services coordinate domain management actions; Operation Services
additionally coordinate durable saga lifecycles. Both use domain gateways, while shared scoped
commands compose reusable domain invariants within one adapter transaction. Each gateway method
returns only after commit, with the runner owning rollback and bounded retries.

This gives each atomic transition an explicit owner and forbids transactional helpers from opening
nested transactions. Runtime rejection of nesting is not yet uniform across adapters. Coordinators
perform asynchronous preflight and remote mint I/O outside the
transaction and publish live events after commit. Authoritative reads and writes share the
transaction scope, preserving atomicity across supported adapters, including IndexedDB.

`Scoped*Commands` names interfaces for state-changing actions within an existing transaction.
Method-specific argument objects use `*Input` types and the parameter name `input`; transaction
runner callbacks are named `work`. These names distinguish actions from their inputs and the work
that composes them.

Coordinators may invoke narrow independently committed actions, such as
`Pick<MintService, 'refreshAndCommitIfStale'>`. The method name and contract disclose remote I/O
and persistence. MintService owns freshness policy, its metadata gateway call, and post-commit
events; Send can reuse the action without reproducing that workflow. Its commit intentionally
survives a later Send failure. Gateways and scoped commands cannot depend on this action or any
other coordinator, and coordinator dependencies must remain acyclic.

## Considered Options

Broad Service dependencies and transaction-scoped Service clones obscure effects and transaction
ownership. Composing separate gateway calls cannot provide one atomic transition. Shared scoped
commands preserve algorithm reuse while keeping transaction creation at the owning gateway.
Requiring every independent commit to appear directly in every caller duplicates refresh workflows;
allowing pure-looking Service calls hides persistence. Explicitly committing actions preserve reuse
while disclosing their effects, without opening transactional code to Service dependencies.

We use agent and human review, scoped types, and behavior tests instead of a custom architecture
checker because partial static analysis adds maintenance cost without establishing effect safety.

## Consequences

The design adds interfaces and stricter dependency boundaries. Adoption is incremental: Keypair
Allocation establishes the baseline, and other workflows migrate through their own gateways while
reusing shared scoped commands. Consistent fail-fast rejection of nested Wallet transactions remains
follow-up work and must distinguish nesting from legitimate concurrent calls. Existing legacy
MintService add, forced-update, trust, and delete paths remain outside this metadata-action migration.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) is the authoritative implementation
contract for naming, dependencies, scope lifetime, concurrency, retries, and review requirements.
