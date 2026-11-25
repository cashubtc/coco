---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Prepare incoming payment requests and link their Receive operations atomically. Claims and restart recovery reject deliveries that fall short after mint input fees before submitting a swap. Older wallets can resume from a saved payload or an unlinked child.
