# Wallet Import and Restore

Reconstruct the Wallet Seed from the user's Wallet Recovery Material using the original
derivation. Open its dedicated database and Coco Session, then call
`coco.wallet.restore(mintUrl)` for each user-selected mint that may hold funds. Restore adds and
trusts that mint, so obtain the mint choice before invoking it.

Omit options to restore all advertised keyset units, or pass `{ units: ['usd'] }` as the second
argument for a selected unit. Restore adds missing proofs and preserves existing proof state,
operation ownership, and the output counter's high-water mark. Keysets commit independently:
if the call rejects after a keyset failure, earlier successful keysets remain committed. Reload
balances and show partial progress rather than treating the whole Restore as rolled back.

Newly discovered proofs reported as `PENDING` by the mint remain locally `pending` and contribute
to none of spendable, reserved, or total balances. Repeat `wallet.restore()` to reconcile them:
unowned pending proofs become ready on `UNSPENT` or spent on `SPENT`. Automatic watching of these
restored pending proofs is not implemented in the current source. Explain that a restored balance
can remain unavailable and provide an explicit recheck action. Preserve existing operation ownership
by using Coco's APIs; a pending proof is not the same as an unclaimed outgoing Send token.

Wallet Import establishes identity; Restore reconstructs proofs from deterministic secrets and
mint state. Startup Operation Recovery instead reconciles local in-flight operations. Keep these
as distinct UI actions. A seed backup alone does not identify every mint or reconstruct all local
history and non-deterministic/imported secrets; preserve the mint list and describe backup limits.

To transfer a different seed's funds into the already open Wallet, use [Sweep](sweep.md).

See [BIP39 and Restore](https://cashubtc.github.io/coco/pages/bip39).

**Done when:** the imported identity uses the original seed derivation, Restore runs against
the selected mints and units, partial failures preserve displayed progress, and unavailable restored
proofs have a recheck path distinct from Operation Recovery.
