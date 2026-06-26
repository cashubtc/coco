# Route quote waiters through canonical quote lifecycle

Quote waiters are exposed through the quote APIs and implemented against
canonical quote lifecycle state rather than raw subscription notifications.
Callers care about whether a known quote is claimable, has observed a new
payment, or has reached a terminal melt quote state, so waiters derive the quote
method from `QuoteIdentity`, observe persisted quote updates, and resolve with
the updated canonical quote instead of transport payloads.

The public `subscription` quote waiting API is removed rather than kept as a
compatibility layer. Migration docs direct callers from
`subscription.awaitMintQuotePaid` to the explicit mint quote waiters and from
`subscription.awaitMeltQuotePaid` to the melt quote paid waiter.
