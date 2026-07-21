---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Add durable one-member BOLT11 Mint Issuance Attempts and their persistence across every maintained
repository adapter.

Attempts retain ordered operation and quote membership with contributed amounts, one aggregate
serialized output set, legal compare-and-transition lifecycle changes, and transactionally atomic
participation with counters, Mint Operations, and proofs. Existing operation and proof rows remain
readable while eligible unlocked BOLT11 issuance now uses write-ahead submission, validates a
complete signature vector, and saves proofs with attempt-level provenance.
