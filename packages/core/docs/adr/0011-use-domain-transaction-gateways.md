---
status: accepted
---

# Use domain transaction gateways for critical Wallet mutations

Coco uses Operation Services as the coordinators for durable operations. A migrated Operation
Service depends on narrow Queries, local capabilities, remote interfaces, and its own
application-scoped `*Transactions` interface; it does not receive repositories, the raw
`CoreTransactionRunner`, or another domain's transaction gateway.

Each `*Transactions` method owns exactly one adapter transaction and returns only after commit.
Cross-domain writes compose through transaction-scoped modules created from the same short-lived
`CoreTransaction`; those modules never open transactions or perform remote I/O. Preflight and
remote mint I/O remain outside transactions, authoritative reads are repeated inside them, and live
events are published only after commit. [Transaction Design](../../../../TRANSACTION_DESIGN.md)
defines the detailed dependency, lifetime, retry, and incremental-migration contract.

An application-scoped `*Transactions` implementation is a leaf adapter around its
`CoreTransactionRunner`. Its caller completes preflight and supplies transaction-ready command
data. The gateway does not depend on regular Services, remote infrastructure, the live `EventBus`,
root repositories, or another application-scoped transaction gateway. Existing dependencies that
violate this boundary remain only as exact, shrinking migration exceptions.

Shared domain modules own reusable invariants and algorithms; operation-specific modules compose
them into atomic transitions. Shared implementations receive repositories from the current
transaction scope and never receive a runner, root repository container, or gateway, including
through helpers. Standalone use wraps the same commands in a gateway; composed use invokes those
commands within the owning transaction. Optional transaction parameters with implicit transaction
creation are forbidden. This preserves reuse without permitting nested transactions.

Queries and preflight capabilities cannot hide Wallet writes. Narrow interfaces may share one
implementation, and no domain is required to reproduce every architectural layer. Reserve
`Operation` for durable sagas and use `TransactionScoped*Commands` for in-transaction behavior.
The keypair implementation is the initial baseline; later proof, output, counter, and handler
migrations reuse these rules. Import/effect guards, scoped types, composition review, and atomicity
tests jointly enforce the contract; a filename check alone does not establish effect safety.
