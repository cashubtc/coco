# Treat Mint Quote expiry as an advisory payment deadline

Status: accepted

Mint Quote expiry is advisory payment-deadline metadata, so Coco trusts canonical Mint Quote
Accounting regardless of when it is observed and does not use its local clock to block
claimability, issuance, Operation Recovery, or Quote Observation. NUT-23 defines BOLT11 expiry as
the deadline for payment, NUT-30 permits on-chain accounting to increase after expiry while a
detected payment resolves, and NUT-04 derives mintable balance from paid and issued amounts.

## Considered Options

We rejected interpreting elapsed Mint Quote expiry as a terminal wallet state because that can hide
valid accounting increases and strand paid value even when the mint still recognizes the payment.
Melt Quote expiry remains unchanged.

## Consequences

Without a reliable remote terminal signal, Mint Quotes may remain observed indefinitely. Retention,
archival, and watcher-aging policy require a separate recovery design.
