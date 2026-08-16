# Cocod Host

Cocod is an opinionated host for one Wallet through Coco. Its language separates the long-running
host from the Wallet and the Coco Session that it manages.

## Language

**Cocod Process**:
A running cocod host that owns one Wallet configuration and serves daemon clients. It may start and
stop a Coco Session without creating or deleting the Wallet.
_Avoid_: Coco Session, Wallet, daemon session
