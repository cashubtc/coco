---
'@cashu/coco-core': patch
---

Settle Sends left in `rolling_back` by an interrupted reclaim. Recovery replays the stored reclaim
request, completes it from restored outputs, or finalizes the Send when the recipient already
claimed the token. A reclaim whose mint call fails now makes one such attempt before rejecting.
