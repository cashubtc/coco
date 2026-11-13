---
'@cashu/coco-core': patch
---

The proof state watcher no longer drops a proof watch when a mint is untrusted and trusted again
while an earlier subscription for the same proofs is still being acquired.
