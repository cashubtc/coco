---
'@cashu/coco-core': minor
---

Reject Mint, Melt, Send, and Receive lifecycle commands for a missing Operation with
`OperationNotFoundError`, and commands unavailable in the Operation's current state with
`OperationStateError`. Both extend `Error` and keep their previous messages, except that a Mint or
Melt Operation found missing under its lock now reports `Operation <id> not found`. The state error
also carries the Operation type, ID, observed state, and accepted states, plus the quote state when
a Melt Quote blocks the command, so callers no longer need to match messages.

Malformed encoded payment requests reject with `PaymentRequestError`, and a missing or unknown
on-chain fee option rejects with `MeltQuoteValidationError`.
