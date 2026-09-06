---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': major
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Atomically allocate purpose-scoped keypairs with their durable high-water marks so
concurrent P2PK and NUT-20 mint-quote calls cannot reuse deterministic keys. Add SQL and IndexedDB
high-water migrations, rollback-safe cross-instance adapter contracts, and explicit
derivation-index exhaustion errors.

Custom repository adapters must implement `KeyRingRepository.getLastAllocatedIndex`,
`getHighestStoredDerivationIndex`, and `setLastAllocatedIndex` using the current repository scope.
These persistence primitives replace the legacy derivation methods. Shared scoped commands choose
the next index, derive synchronously, and persist the key with its high-water mark inside the
owning Wallet transaction; adapters must not open another transaction for allocation.

Replace the adapter-test exports `runKeyRingDerivationRepositoryContract` and
`KeyRingDerivationContractOptions` with `runKeypairAllocationContract` and
`KeypairAllocationContractOptions`. The allocation contract exercises the real key-management
gateway.
