---
'@cashu/coco-core': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Migrate legacy Mint Operations with durable outputs into single-member Mint Issuance Attempts.

Repository initialization now preserves exact legacy outputs, counter state, quote identity,
terminal outcomes, and proof provenance while making interrupted upgrades safe to resume.
Historical attempt counter ranges are marked unknown instead of being inferred from the current
counter, and migrated BOLT12/on-chain operations continue through their existing recovery handlers.
