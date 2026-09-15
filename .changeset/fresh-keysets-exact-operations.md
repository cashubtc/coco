---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Upgrade cashu-ts to 5.0.0-rc.9 with revision-guarded keyset refresh and persisted operation recovery.
Keep exact output allocations after rotation, release only definitively rejected first submissions,
and preserve ambiguous replay outcomes. SQL adapters migrate metadata revisions and Mint submission
markers; update core and adapters together. Payment Request construction uses the options object;
advisory mint lists and payment-method fees remain unsupported. Amounts now follow cashu-ts's uint64
limit.
