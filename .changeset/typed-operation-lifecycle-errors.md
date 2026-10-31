---
'@cashu/coco-core': minor
---

Reject Mint, Melt, Send, and Receive lifecycle commands for a missing Operation with
`OperationNotFoundError`, and commands unavailable in the Operation's current state with
`OperationStateError`. Both extend `Error` and keep their previous messages, except that a Mint
Operation found missing under its lock now reports `Operation <id> not found`. The state error also
carries the Operation type, ID, observed state, and accepted states, plus the quote state when a
Melt Quote blocks the command, so callers no longer need to match messages.

A trust change now succeeds once committed even when the stale metadata refresh that follows it
fails; the stored metadata is published instead. Malformed encoded payment requests reject with
`PaymentRequestError`, and a missing or unknown on-chain fee option rejects with
`MeltQuoteValidationError`.

`paymentRequests.parse()` accepts an optional `amount`, so `payableMints` for an amountless request
lists only the Mints that can pay it.
