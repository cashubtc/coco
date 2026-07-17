---
'@cashu/coco-core': patch
---

Batch compatible mint-quote checks through NUT-29 while preserving each attributable canonical
quote observation independently. Explicit refreshes remain immediate and target-isolated, polling
rotates bounded mint/method cohorts, and atomic validation failures isolate faulty quotes without
fabricating canonical state.
