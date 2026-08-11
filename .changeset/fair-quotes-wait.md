---
'@cashu/coco-core': patch
---

Treat `expiry: 0` on mint quotes as no expiry.

BOLT12 and onchain reusable quotes that use the zero no-expiry sentinel now remain watched and
claimable, while positive timestamps in the past continue to expire normally.
