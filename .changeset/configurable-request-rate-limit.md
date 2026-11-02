---
'@cashu/coco-core': minor
---

Add `requestRateLimit` to `CocoConfig` to set the per-mint request burst size and refill rate, or to
disable request queueing. Defaults are unchanged at 20 requests with 20 refilled per minute.
