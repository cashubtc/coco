---
'@cashu/coco-core': patch
---

Treat empty BOLT11 quote public keys as absent when checking ownership during payment polling and recovery, so unlocked paid quotes can finalize without an ownership conflict.
