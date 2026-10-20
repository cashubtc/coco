---
'@cashu/coco-core': patch
---

Simplify internal Wallet transaction composition by letting coordinators use the shared runner and
reusable branded transitions through `tx.perform`, which tracks the entire transition automatically.
Name shared capabilities `Scoped*` to make their lifetime within an existing transaction explicit,
and keep each lifecycle's transitions alongside its operation code. Preserve atomic Send, keypair,
and mint metadata updates, transaction lifetime protection, recovery behavior, and post-commit events.
