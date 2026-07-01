# Remove public subscription quote waiters

The public `subscription.awaitMintQuotePaid` and
`subscription.awaitMeltQuotePaid` helpers are removed rather than routed through
another public waiter layer. They returned raw transport notification payloads
while their names implied canonical quote lifecycle guarantees.

Canonical quote state is still exposed through durable `manager.quotes.*`
get/refresh APIs and typed `manager.on(...)` events such as
`mint-quote:updated` and `melt-quote:updated`. Callers that need live quote
state should subscribe to those events and filter by `{ mintUrl, quoteId }`.
Callers that need value movement completion should use operation APIs and
operation events such as `mint-op:finalized` or `melt-op:finalized`.
