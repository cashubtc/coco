---
'coco-cashu-adapter-tests': patch
'coco-cashu-expo-sqlite': patch
'coco-cashu-sqlite-bun': patch
'coco-cashu-indexeddb': patch
'coco-cashu-sqlite3': patch
'coco-cashu-core': patch
---

Persist bolt11 melt `payment_preimage` data on finalized operations via method-specific
`finalizedData`, store it across all melt operation repositories, and update adapter tests to
require preimage propagation only when the mint actually returns one.
