---
'@cashu/coco-core': major
---

Remove the public `SubscriptionApi` quote waiters. Use canonical quote events through
`manager.on('mint-quote:updated', ...)` or `manager.on('melt-quote:updated', ...)`, explicit quote
refreshes, and operation APIs for mint or melt completion.
