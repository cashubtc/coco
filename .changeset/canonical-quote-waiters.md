---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
---

Route public quote waiters through canonical quote APIs.

Mint quote waits now live under `manager.quotes.mint.awaitClaimable` and
`manager.quotes.mint.awaitNextPayment`, while melt settlement waits live under
`manager.quotes.melt.awaitPaid`. The old subscription quote waiters were removed
because they exposed raw transport notifications instead of canonical quote
snapshots.
