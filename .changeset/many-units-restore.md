---
'@cashu/coco-core': minor
'@cashu/coco-react': minor
'@cashu/coco-indexeddb': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-adapter-tests': minor
---

Add first-class custom Cashu unit support across core APIs, React balance hooks,
operation recovery, and storage adapters.

Bare amount inputs continue to default to sats, while object-form amount inputs
carry an explicit unit. Proofs, balances, quotes, operations, history, tokens,
restore/sweep flows, and adapter persistence now preserve normalized unit
metadata, with migrations and contract tests covering legacy sat fallback and
custom-unit rows.
