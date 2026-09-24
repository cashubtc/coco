---
'@cashu/coco-core': patch
---

Simplify internal Wallet transaction composition by letting coordinators use the shared runner and
reusable local transition functions. Make scoped capabilities and workflow transitions explicit in
module names, and keep each lifecycle together under the workflow transitions directory. Preserve atomic Send, keypair, and mint metadata updates,
transaction lifetime protection, recovery behavior, and post-commit events.
