---
'@cashu/coco-core': patch
---

Treat empty BOLT11 quote public keys as absent consistently during payment checks, background polling, recovery, and quote observation comparisons, so unlocked paid quotes can finalize without ownership conflicts or spurious change events.
