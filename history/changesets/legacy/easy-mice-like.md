---
'coco-cashu-adapter-tests': patch
'coco-cashu-expo-sqlite': patch
'coco-cashu-indexeddb': patch
'coco-cashu-sqlite3': patch
'coco-cashu-core': patch
---

Feat: Add checkInflightProofs method and wired it up inside proofStateWatcher, so that inflight proofs are state-checked on startup and subscribed to if still inflight
