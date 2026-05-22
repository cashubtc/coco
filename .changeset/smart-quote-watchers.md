---
'@cashu/coco-core': patch
---

Watch canonical BOLT11 mint quotes without requiring local mint operations.

Mint quote creation now emits the canonical `mint-quote:updated` event after persistence, and the
mint operation watcher subscribes to pending BOLT11 quote records directly on startup or when a
canonical quote update appears. Remote quote notifications update the canonical quote row first, so
pending operations continue to advance from quote-level events instead of watcher-owned operation
state.
