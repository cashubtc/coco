---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Accept incoming payment request deliveries atomically across wallet sessions. When a transport starts ingestion on the session that created the request and activation then fails, an accepted payment can still settle.
