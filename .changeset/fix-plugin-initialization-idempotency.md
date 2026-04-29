---
'@cashu/coco-core': patch
---

Prevent plugins from initializing twice through `initializeCoco()`, and make
plugin lifecycle hooks idempotent across repeated or concurrent init and ready
calls.
