---
'@cashu/coco-core': major
'@cashu/coco-react': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-adapter-tests': major
---

Add first-class custom Cashu unit support across core APIs, React balance hooks,
operation recovery, and storage adapters.

Bare amount inputs continue to default to sats, while object-form amount inputs
carry an explicit unit. Proofs, balances, quotes, operations, history, tokens,
restore/sweep flows, and adapter persistence now preserve normalized unit
metadata, with migrations and contract tests covering legacy sat fallback and
custom-unit rows.
