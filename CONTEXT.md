# Coco Cashu

Coco Cashu models a seed-rooted Cashu wallet that interacts with one or more mints.
This language keeps durable wallet identity separate from runtime sessions and mint-scoped work.

## Language

**Wallet**:
A user's durable Cashu holding context, identified by seed-derived secrets that can be proven against mints. A wallet can have incomplete local state; previous activity may require restore before its proofs are usable again.
_Avoid_: Manager, SDK wallet, account

**Wallet Seed**:
The secret root from which a wallet's deterministic Cashu secrets are derived.
_Avoid_: Account, private key

**Coco Session**:
A running Coco instance through which an application uses a wallet. Ending a session does not end the wallet; starting again with the same wallet inputs creates a new session for the same wallet.
_Avoid_: Wallet instance, app instance

**Wallet Instance**:
A transient mint-and-unit-scoped view of a wallet used for a specific mint interaction. It is not the wallet's identity.
_Avoid_: Wallet, account

**Known Mint**:
A mint whose information and keysets are retained locally, whether or not the user trusts it for wallet operations.
_Avoid_: Added mint, cached mint

**Trusted Mint**:
A known mint approved for wallet operations.
_Avoid_: Active mint

**Restore**:
The act of reconstructing a wallet's proofs for a mint from the wallet's deterministic secrets and the mint's state. Restore is distinct from operation recovery and does not create a persistent restored state.
_Avoid_: Recovery, import, restored mint, restored wallet

**Operation Recovery**:
The act of reconciling persisted in-flight wallet operations after interruption so local operation state, proof state, and mint state agree again.
_Avoid_: Restore, restart, resume
