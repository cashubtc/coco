---
'@cashu/coco-core': patch
---

Claim reusable onchain mint quotes from the mint operation processor.

When automatic mint quote claiming is enabled, claim processing now drains remaining claimable
onchain quote balance by creating one pending mint operation and executing it under the quote lock.
The processor claims pending reusable quotes on startup, reacts to canonical `mint-quote:updated`
events asynchronously by full quote identity, and exposes an opt-out through
`autoClaimMintQuotes`.
