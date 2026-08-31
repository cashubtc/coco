---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Establish one strong Wallet repository transaction scope across memory, SQLite, Expo SQLite, and
IndexedDB adapters. Transactions now provide atomic commit and rollback, isolate concurrent work,
include keypair allocation in the scoped repository foundation, acquire SQLite writer ownership
before callback reads, reject nested IndexedDB strong scopes, and report transient adapter
contention with `RepositoryTransactionConflictError` while preserving callback failures unchanged.
