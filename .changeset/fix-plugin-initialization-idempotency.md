---
'@cashu/coco-core': patch
---

Prevent plugins from initializing twice through `initializeCoco()`, and make
plugin lifecycle hooks idempotent across repeated or concurrent init and ready
calls. Registering the same plugin instance more than once now throws instead
of creating an unbalanced dispose lifecycle.
