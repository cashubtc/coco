---
'@cashu/coco-core': patch
---

Extract read-only balance aggregation out of `ProofService` into `StoredBalanceQueries`
(`packages/core/proofs/BalanceQueries.ts`), following the `Queries` pattern used elsewhere in the
core package. `WalletBalancesApi` now depends on this narrow `BalanceQueries` interface (ready-proof
reads plus trusted-mint lookup) instead of requiring a full `ProofService`.

`WalletBalancesApi` methods and their signatures are unchanged.
