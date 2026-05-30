---
'@cashu/coco-core': patch
---

Watch reusable onchain mint quotes through the mint operation watcher.

Onchain mint quote subscriptions now use polling as a concrete fallback, keep logical watches alive
when WebSocket subscriptions are rejected, persist complete counter updates, and keep reusable quote
watches running after individual claims finalize.
