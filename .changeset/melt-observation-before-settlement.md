---
'@cashu/coco-core': patch
---

Record pending melt quote observations before settling local melt operations, and use cached PAID
observations during recovery only when serialized settlement change and method-specific settlement
metadata are available.
