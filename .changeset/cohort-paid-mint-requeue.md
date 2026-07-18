---
'@cashu/coco-core': patch
---

Resolve the complete eligible paid Mint Operation set before requeueing it so automatic processing
can preserve processor batching cohorts across asynchronous repository adapters.
