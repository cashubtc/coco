# Cocod Host

Cocod is an opinionated host for one Wallet through Coco. Its language separates the long-running
host from the Wallet and the Coco Session that it manages.

## Language

**Cocod Owner**:
The single person or organization whose Wallet a Cocod Process hosts. Every Cocod Client acts on
behalf of the same Cocod Owner.
_Avoid_: Tenant, account, client

**Cocod Process**:
A running cocod host that owns one Wallet configuration and serves daemon clients. It may start and
stop a Coco Session without creating or deleting the Wallet.
_Avoid_: Coco Session, Wallet, daemon session

**Cocod Client**:
A downstream consumer that calls a Cocod Process on behalf of its Cocod Owner. Multiple Cocod
Clients may use one Cocod Process, but they do not own separate Wallets within it.
_Avoid_: Tenant, user, Wallet

**Client Capability**:
A named permission associated with a Client Credential that authorizes a category of actions on a
Cocod Process.
_Avoid_: Role, Wallet Seed Access, client type

**Wallet Seed Access**:
Whether a Cocod Process can currently derive a Wallet's secrets from its Wallet Seed. Wallet Seed
Access can be locked while the Wallet continues to exist.
_Avoid_: Wallet state, Coco Session, client authentication

**Client Credential**:
Material one or more Cocod Clients present to prove Client Capabilities on cocod's network
interface. It grants authority without necessarily identifying an individual consumer, and it does
not grant Wallet Seed Access.
_Avoid_: Wallet passphrase, Wallet login, client session

**Unattended Coco Session Start**:
Starting a Coco Session without client-supplied unlocking input because the Wallet has no configured
passphrase.
_Avoid_: Unattended login, automatic authentication
