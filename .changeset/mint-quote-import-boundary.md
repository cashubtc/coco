---
'@cashu/coco-core': major
'@cashu/coco-react': major
---

Move mint quote import to `manager.quotes.mint.import(...)` and remove
`manager.ops.mint.importQuote(...)`.

Mint quote import now only updates canonical quote state and emits
`mint-quote:updated` when a quote is created/imported or remote settlement state
changes. Mint operations no longer mirror mutable quote remote state; callers
should read quote state from `manager.quotes.mint.get(...)` or quote events and
call `manager.ops.mint.prepare(...)` when they want an operation/history entry.
