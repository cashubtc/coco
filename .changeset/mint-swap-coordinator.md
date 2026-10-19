---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Add the dormant Mint Swap coordinator using shared Mint and Melt transitions, atomic parent/child preparation and settlement, exact-request recovery, and durable cancellation and retry evidence. Continue authorized source execution and recovery of paid value after trust revocation without restoring trust, repeating payment, or replacing outputs. Public Mint Swap activation remains separate.

Require Mint Swap persistence in every adapter and Wallet transaction scope, removing the `mintSwap` constructor option. Custom repository implementations must supply `mintSwap.operationRepository`. Remove per-record `schemaVersion` while retaining reads of existing version-1 records; adapter migrations govern persisted format changes.
