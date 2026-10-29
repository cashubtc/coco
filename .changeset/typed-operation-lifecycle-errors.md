---
'@cashu/coco-core': minor
---

Reject Mint, Melt, Send, and Receive lifecycle commands for a missing Operation with
`OperationNotFoundError`, and commands unavailable in the Operation's current state with
`OperationStateError`. Both extend `Error` and keep their previous messages; the state error also
carries the Operation type, ID, observed state, and accepted states, so callers no longer need to
match messages.

A trust change now succeeds once committed even when the stale metadata refresh that follows it
fails; the stored metadata is published instead. Malformed encoded payment requests reject with
`PaymentRequestError`.
