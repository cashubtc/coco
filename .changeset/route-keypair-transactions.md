---
'@cashu/coco-core': minor
---

Route purpose-specific Keypair Allocation through the composition-root-owned transaction gateway so
the derived key and durable high-water mark commit atomically.

Separate shared read-only key queries, derivation preflight, and P2PK signing from key-management
transactions. Reuse scoped keypair commands within an owning transaction, and enforce the shared
transaction architecture as the baseline for later operation refactors.

Distinguish transaction gateways (`*Transactions`) from in-transaction command interfaces
(`Scoped*Commands`), and check dependency boundaries through selected type re-exports.
