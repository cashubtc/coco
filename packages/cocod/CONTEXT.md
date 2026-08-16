# Cocod Host

Cocod is an opinionated host for one Wallet through Coco. Its language separates the long-running
host from the Wallet and the Coco Session that it manages.

## Language

**Cocod Process**:
A running cocod host that owns one Wallet configuration and serves daemon clients. It may start and
stop a Coco Session without creating or deleting the Wallet.
_Avoid_: Coco Session, Wallet, daemon session

**Wallet Seed Access**:
Whether a Cocod Process can currently derive a Wallet's secrets from its Wallet Seed. Wallet Seed
Access can be locked while the Wallet continues to exist.
_Avoid_: Wallet state, Coco Session, client authentication

**Client Credential**:
Material a client presents to prove its authorized capabilities on cocod's network interface. It
does not grant Wallet Seed Access.
_Avoid_: Wallet passphrase, Wallet login, client session

**Unattended Coco Session Start**:
Starting a Coco Session without client-supplied unlocking input because the Wallet has no configured
passphrase.
_Avoid_: Unattended login, automatic authentication
