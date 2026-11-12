---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-indexeddb': minor
---

Keep a keyset's optional final expiry from the mint through storage and into every cashu-ts key
chain. A V2 keyset id commits to the expiry, so dropping it made a valid expiring keyset unusable:
operations on a mint whose only active keyset expires failed with "No active keyset found".

Adapter migration notes (repository compatibility policy):

- `Keyset` gains optional `finalExpiry` (Unix seconds). `KeysetRepository.addKeyset` and
  `updateKeyset` must store the incoming value, replacing the stored one, and the read methods
  must return it. `runKeysetRepositoryContract` from `@cashu/coco-adapter-tests` now checks this.
- Persistence migrations are additive. SQL storage (sqlite3, sqlite-bun, expo-sqlite) adds
  migration `046_keyset_final_expiry` with a nullable `finalExpiry` column. IndexedDB stores the
  property without a schema version change. Keysets stored by earlier releases read back without
  an expiry and gain it the next time their mint metadata is refreshed.
