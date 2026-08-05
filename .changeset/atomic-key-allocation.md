---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Atomically derive and persist purpose-scoped keypairs with their durable high-water marks so
concurrent P2PK and NUT-20 mint-quote calls cannot reuse deterministic keys. Add SQL and IndexedDB
high-water migrations, rollback-safe cross-instance adapter contracts, and explicit
derivation-index exhaustion errors.

Custom repository adapters must replace `getLastDerivationIndex` with the required
`KeyRingRepository.deriveAndPersistKeyPair` transaction boundary.
