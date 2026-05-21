---
'@cashu/coco-core': major
---

Replace the operation-shaped `mint-op:quote-state-changed` event with the
quote-level `mint-quote:updated` event.

Quote observers now receive the canonical mint quote snapshot after it has been
persisted, while mint operation progress remains exposed through `mint-op:*`
lifecycle events.
