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

Core now exposes canonical quote resurfacing through `manager.mintQuotes` and
supports preparing BOLT11 mint operations against an existing canonical quote ID
while preserving the existing `prepare({ amount })` compatibility wrapper. Mint
quote records are keyed by normalized `(mintUrl, method, quoteId)`, and mint
operation quote lookups now return all sibling operations for the full quote
identity.

Persistent adapters now store canonical mint quotes, migrate existing BOLT11
operation quote snapshots into non-reusable quote rows, and expose contract
coverage for quote records and sibling operation lookup.
