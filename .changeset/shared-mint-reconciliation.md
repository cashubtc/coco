---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-adapter-tests': major
---

Unify standalone Mint accounting and exact-output recovery across BOLT11, BOLT12, and on-chain
quotes. Preserve exact request variants, uncertain reservations, and issuance evidence atomically;
accept partial BOLT11 accounting while keeping normal legacy full-amount claiming compatible.

Storage adapters must implement the new Mint recovery repository in every transaction scope.
Upgrade core and adapters together with all old writers stopped; mixed-version writing and
post-upgrade downgrades are unsupported. Legacy pending operations with unknown submission history
remain reserved for recovery. Ambiguous requests are not automatically replayed without a verified
mint concurrency contract, and finalized issuance can include proofs whose spendability is pending
or already spent.
