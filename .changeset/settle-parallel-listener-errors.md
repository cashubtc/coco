---
'@cashu/coco-core': patch
---

Fix EventBus parallel dispatch so a listener that throws synchronously no longer skips its sibling listeners or bypasses `onError`/`throwOnError` handling.
