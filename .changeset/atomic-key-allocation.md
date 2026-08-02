---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Atomically reserve purpose-scoped key derivation indexes before key generation so concurrent P2PK
and NUT-20 mint-quote calls cannot reuse deterministic keys. Add durable SQL and IndexedDB
high-water migrations, permanent gap semantics, cross-instance adapter contracts, and explicit
derivation-index exhaustion errors.

Custom repository adapters must replace `getLastDerivationIndex` with the required root-only
`KeyRingAllocationRepository.reserveNextDerivationIndex` capability.
