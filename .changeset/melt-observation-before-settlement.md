---
'@cashu/coco-core': patch
---

Record pending melt quote observations before settling local melt operations, and treat cached PAID
observations as terminal during recovery without refreshing the remote quote first.
