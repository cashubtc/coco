---
'@cashu/coco-core': patch
---

Restore `Amount` instances for melt change signatures that arrive in WebSocket notifications, so a Melt Operation settled from a notification stores change proofs with the correct amounts.
