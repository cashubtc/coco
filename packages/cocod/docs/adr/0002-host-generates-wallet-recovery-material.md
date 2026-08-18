---
status: accepted
---

# Let cocod generate and re-export Wallet Recovery Material

Network initialization in v1 always creates new Wallet Recovery Material inside the Cocod Process
and returns its BIP39 mnemonic to the administrative client. Because initial response delivery can
fail, `wallet:admin` may retrieve the mnemonic again through a repeatable, non-cacheable endpoint.
For an unencrypted Wallet, the administrative Client Credential is sufficient; for a
passphrase-encrypted Wallet, every retrieval also requires the passphrase. Retrieval is independent
of Coco Session state and does not start, stop, or unlock a session.

This makes `wallet:admin` root Wallet authority and deliberately lets every holder of the shared v1
credential export an unattended Wallet. Initializing from existing Wallet Recovery Material is not
part of the network interface in v1; a later host-local workflow may perform that initialization
before Coco Restore reconstructs proofs.
