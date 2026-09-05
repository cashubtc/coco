---
status: accepted
---

# Use domain transaction gateways for critical Wallet mutations

Coco uses one composition-root-owned transaction runner behind narrow domain transaction gateways
for critical Wallet mutations. Orchestration performs preflight, remote mint I/O, and post-commit
events, while each authoritative local transition uses one adapter transaction; this avoids
repository access and transaction-scoped service clones in orchestration while remaining portable
to IndexedDB. Send and core Receive validate the seam incrementally, while durable outbox delivery
and systematic network fault injection remain separate work.

[Transaction Design](../../../../TRANSACTION_DESIGN.md) is the maintained contract. Standalone Mint
Operations now implement the first operation-owned gateway on the merged strong repository
foundation. This does not require the separate keyring, Send, or Receive migrations. Each Mint
gateway command is a leaf transaction adapter; remote work and event publication remain outside it.
