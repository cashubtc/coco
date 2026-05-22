---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-adapter-tests': major
---

Add canonical method-aware mint quote records and make BOLT11 mint preparation
quote-first.

Core now exposes canonical quote resurfacing through `manager.quotes.mint` and
`manager.quotes.melt`. BOLT11 mint and melt quotes are created before
`manager.ops.mint.prepare()` and `manager.ops.melt.prepare()`, keeping bare
quote creation out of history. Mint quote records are keyed by normalized
`(mintUrl, method, quoteId)`, and mint operation quote lookups now return all
sibling operations for the full quote identity.

Persistent adapters now store canonical mint and melt quotes, migrate existing
BOLT11 operation quote snapshots into quote rows, and expose contract coverage
for quote records and sibling operation lookup.
