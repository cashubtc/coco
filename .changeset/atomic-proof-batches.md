---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Save each multi-keyset proof batch atomically before publishing per-keyset events and success logs.
A collision or persistence failure leaves no new proofs from the request saved. Preserve typed
persistence errors and prevent listener failures from rejecting an already committed batch.

Add shared repository coverage for multi-keyset persistence and collision rollback.
