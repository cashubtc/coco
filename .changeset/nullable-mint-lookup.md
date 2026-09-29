---
'@cashu/coco-core': major
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
---

Add `MintRepository.findMintByUrl`, a nullable single-mint lookup that returns `null` instead of
throwing when the mint is absent. `StoredMintQueries.getMetadata()` and
`RepositoryMintMetadataCommands.applyObservation()` now use it instead of loading every mint via
`getAllMints()` to find one by URL.

Custom repository adapters must implement `MintRepository.findMintByUrl`. The existing
`getMintByUrl`, which throws on a miss, is unchanged.
