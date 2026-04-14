---
'@cashu/coco-core': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
---

Track receive history entries through prepared, finalized, and rolled-back
operation states, and persist the correct receive unit across storage adapters.

Core now emits explicit receive operation lifecycle events and updates history
entries incrementally instead of only recording receives once a token has been
created. The persistent adapters now support receive history lookups and
updates, and receive operations persist their unit so non-sat history entries
stay correct through recovery and restart flows.
