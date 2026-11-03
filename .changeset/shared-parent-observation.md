---
'@cashu/coco-core': patch
---

Share synchronous quote-interest declarations between ordinary operations and Mint Swap parents.
Watchers own subscription setup and cleanup, allowing cached parent progression during slow or failed
acquisition. Prefer sufficient cached evidence at parent startup while retaining bounded recovery.
