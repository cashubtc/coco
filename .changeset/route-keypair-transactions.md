---
'@cashu/coco-core': minor
---

Route purpose-specific Keypair Allocation through the composition-root-owned transaction gateway so
the derived key and durable high-water mark commit atomically.

Separate shared read-only key queries, derivation preflight, and P2PK signing from key-management
transactions. Reuse scoped keypair commands within an owning transaction, and establish the shared
transaction architecture as the baseline for later operation refactors.

Distinguish transaction gateways (`*Transactions`) from in-transaction command interfaces
(`Scoped*Commands`).
Use `*Queries` consistently for read-only state interfaces.

Move index selection, exhaustion checks, and synchronous derivation into the shared scoped keypair
command. Repositories expose allocation-state reads and writes, and concurrent allocations within
one scope are ordered before committing their keys and high-water marks together.
