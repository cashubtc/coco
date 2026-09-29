---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Verify that a mint's keys derive the keyset id they are served under (NUT-02), and make stored
keyset keys immutable.

A keyset id commits to its keys, so keys that do not derive the advertised id belong to another
keyset. `MintAdapter.fetchKeysForId` now takes the `/v1/keysets` entry rather than a bare id and
reconciles it with the `/v1/keys` response through `Keyset.fromMintApi`, which also rejects a keys
response whose own id, unit or expiry contradicts the advertised entry. The advertised entry is
required because an `01`-prefixed id also commits to `unit`, `input_fee_ppk` and `final_expiry`,
and `/v1/keys` omits `final_expiry`. Failures raise the new `KeysetVerificationError`.

Metadata refresh reuses stored keys only while they still derive the advertised entry, so a mint
cannot raise `input_fee_ppk` or change the expiry of an `01`-prefixed keyset without serving keys
that derive the changed id.

A mint that serves bad keys for one keyset no longer costs the Wallet the keysets that did verify:
metadata refresh skips the unverifiable keyset with a warning instead of failing the whole refresh,
so existing balances at that mint stay reachable.

`KeysetRepository.addKeyset` now keeps keys already stored for a keyset id, adopts incoming keys
only to backfill a keyset whose metadata was recorded without them, and raises the new
`KeysetKeysConflictError` when a write would replace stored keys with different ones. Custom
repository adapters should apply the same rule through `reconcileKeysetKeypairs`, exported from
`@cashu/coco-core/adapter`.

Add `runKeysetRepositoryContract` to adapter tests to exercise these rules against every adapter.
