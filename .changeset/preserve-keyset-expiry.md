---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Preserve optional keyset final expiry through mint metadata refresh, storage, and Wallet cache
construction so expiring V2 keysets remain usable. Add a nullable SQL column without changing
existing keys; older IndexedDB rows remain readable without expiry.
