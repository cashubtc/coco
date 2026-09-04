---
'@cashu/coco-core': patch
---

Centralize Effect structured concurrency for background task ownership and cleanup. Mint operation
requeues are now deduplicated through processing and retry, scheduled work is cancelled when its
mint becomes untrusted, and proof-state event work and subscriptions share the same scoped
lifecycle.
