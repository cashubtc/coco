# Wallet Import and Restore

Reconstruct the Wallet Seed from the user's Wallet Recovery Material using the original
derivation. Open its dedicated database and Coco Session, then call
`coco.wallet.restore(mintUrl)` for each user-selected mint that may hold funds. Restore adds and
trusts that mint, so obtain the mint choice before invoking it.

Wallet Import establishes identity; Restore reconstructs proofs from deterministic secrets and
mint state. Startup Operation Recovery instead reconciles local in-flight operations. Keep these
as distinct UI actions. A seed backup alone does not identify every mint or reconstruct all local
history and non-deterministic/imported secrets; preserve the mint list and describe backup limits.

See [BIP39 and Restore](https://cashubtc.github.io/coco/pages/bip39).

**Done when:** the imported identity uses the original seed derivation, Restore runs against
the selected mints, and the UI distinguishes reconstructed proofs from recovered local operations.
