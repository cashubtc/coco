---
'@cashu/coco-core': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-adapter-tests': patch
---

Add quote-first NUT-30 onchain melt operations.

Core now supports onchain melt quotes, fee option selection on melt operations,
onchain melt execution, and onchain melt quote polling. Adapter repositories now
persist onchain melt quote fee options and outpoints with migrations for existing
melt quote rows.
