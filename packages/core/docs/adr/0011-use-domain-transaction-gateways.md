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
