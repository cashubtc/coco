---
'@cashu/coco-react': patch
---

Serialize localStorage seed initialization across same-origin browser contexts with the Web Locks
API, preventing concurrent first-run tabs from caching different wallet seeds.
