---
'@cashu/coco-core': patch
---

Keep Send proof subscriptions independent of startup recovery. Proof watcher discovery uses local
evidence without repeating recovery's mint checks, so a slow legacy P2PK check cannot delay observation
of other Sends. Legacy completion still verifies the full output allocation with the mint.
