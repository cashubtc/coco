---
'@cashu/coco-adapter-tests': patch
'@cashu/coco-core': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
---

Upgrade to cashu-ts 5.0.0-rc.4 and consume normalized v5 mint quote snapshots at Coco's quote
lifecycle boundary. BLS v3 keysets are temporarily excluded from wallet keysets, and tokens using
v3 proofs are rejected until Coco supports curve-aware proof-state handling.
