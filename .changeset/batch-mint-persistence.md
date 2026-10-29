---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-indexeddb': minor
---

Add durable Batch Mint Operation storage, and read every Mint Quote claimability decision from one shared set of local claim facts that counts finalized and `executing` Batch Mint Members alongside Mint Operations. No public API or mint request changes yet, and behaviour is unchanged while no Batch Mint Operation exists.

Adapter migration notes (repository compatibility policy):

- `Repositories` and `RepositoryTransactionScope` now require `batchMint: BatchMintPersistence`, i.e. `batchMint.operationRepository: BatchMintOperationRepository`, bound to the same Wallet transaction as every other repository so it commits and rolls back with it. Custom adapters must supply it in the root and every transaction scope.
- `BatchMintOperationRepository` provides `create`, `update`, `getById`, `listByState`, `listInFlight` and `listByQuote`. Store members as separately indexed records (operation, ordinal, Quote Identity, amount, plus the payment request snapshot and NUT-20 signature or `null`) and return operations hydrated with members in ordinal order. Lists order by `createdAt`, then ID. Normalize mint URLs. Call `assertBatchMintOperation` before `create` (duplicate ordinals and Quote Identities are rejected) and `assertBatchMintUpdate` before `update` (membership and request material are immutable; only `executing` may change state). Both helpers and the model types are exported from `@cashu/coco-core/adapter`.
- Validate custom adapters with `runBatchMintPersistenceContract` from `@cashu/coco-adapter-tests`.
- Persistence migrations are additive. SQL storage (sqlite3, sqlite-bun, expo-sqlite) adds migration `045_batch_mint_operations` with the `coco_cashu_batch_mint_operations` and `coco_cashu_batch_mint_members` tables. IndexedDB adds schema version 36 with the matching stores. Existing Wallets load unchanged; `MintOperationRepository` and its persisted schema are unchanged.
