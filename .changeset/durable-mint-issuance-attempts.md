---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Add durable Mint Issuance Attempt persistence across every maintained repository adapter.

Adapters now preserve exact ordered attempt membership, quote amounts, output and counter
allocation, request reconstruction and recovery metadata. New proofs can be queried by issuance
attempt while retaining legacy operation provenance.
