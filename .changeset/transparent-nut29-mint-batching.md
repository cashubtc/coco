---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-react': patch
'@cashu/coco-sql-storage': patch
---

Implement transparent NUT-29 mint batching around durable Mint Issuance Attempts.

App-facing Mint Operations now use an explicit safe projection while adapter-facing records retain
attempt and recovery metadata. Every fixed-amount BOLT11 redemption uses a durable attempt with
atomic output and counter allocation, exact proof provenance, restart-safe legacy migration, and
canonical recovery for confirmed, ambiguous, unpaid, expired, and already-issued outcomes.

Compatible background quote checks and processor redemption use bounded, fair NUT-29 batches with
target-isolated explicit calls, deterministic validation isolation, fresh-output fallback, and
force-single or normalized-mint denylist controls. Maintained repository adapters persist the new
attempt model and preserve batching cohorts across asynchronous transaction implementations.
