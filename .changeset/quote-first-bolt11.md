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

Quote observers now receive the persisted canonical mint quote snapshot through
the quote-level `mint-quote:updated` event, replacing the operation-shaped
`mint-op:quote-state-changed` event. Mint operation progress remains exposed
through `mint-op:*` lifecycle events.

Method handler quote refresh hooks are now named `fetchRemoteQuote`, with
matching `FetchRemote*QuoteContext` types, so handlers own remote protocol fetches
while quote lifecycle services own canonical quote persistence and refresh
events.

Persistent adapters now store canonical mint and melt quotes, migrate existing
BOLT11 operation quote snapshots into quote rows, and expose contract coverage
for quote records and sibling operation lookup.

Mint quote records now store method-scoped `quoteData` so BOLT11 fixed amounts
and NUT-30 onchain balance snapshots can share the same canonical quote
repository without requiring universal top-level quote `amount` or `state`
fields.

Keyring persistence now tracks key purpose metadata so NUT-20 mint quote keys
can use a separate deterministic derivation branch and stay hidden from
user-facing P2PK key management APIs.

NUT-30 onchain mint quote creation now derives a fresh NUT-20 key, submits the
public key in the onchain quote request, and persists the reusable address quote
with `amount_paid`/`amount_issued` balance metadata.
