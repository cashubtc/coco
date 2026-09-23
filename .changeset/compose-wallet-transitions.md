---
'@cashu/coco-core': patch
---

Simplify internal Wallet transaction composition by letting coordinators use the shared runner and
reusable local transition functions. Preserve atomic Send, keypair, and mint metadata updates,
transaction lifetime protection, recovery behavior, and post-commit events.
