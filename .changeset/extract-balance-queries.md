---
'@cashu/coco-core': patch
---

Extract read-only balance aggregation out of `ProofService` into `StoredBalanceQueries`
(`packages/core/proofs/BalanceQueries.ts`), following the `Queries` pattern used elsewhere in the
core package. `WalletBalancesApi` now depends on this narrow `BalanceQueries` interface (ready-proof
reads plus trusted-mint lookup) instead of requiring a full `ProofService`.

`ProofService` keeps every existing balance method, now delegating to `BalanceQueries` internally,
and its constructor gains one new optional trailing `balanceQueries` parameter (defaulting to an
internally constructed instance when omitted). No plugin `ServiceMap` or public method signature
changes.
