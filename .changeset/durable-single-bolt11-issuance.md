---
'@cashu/coco-core': patch
---

Redeem new fixed-amount BOLT11 mint operations through durable single-member issuance attempts.

Attempt attachment now reserves exact deterministic outputs and counters atomically, marks possible
submission before remote I/O, attributes proofs to the attempt, and keeps interrupted execution
recoverable across restart.
