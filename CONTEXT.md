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

**Built-in Payment Method**:
A payment method that coco models with method-specific behavior and validation. The built-in payment
methods are `bolt11`, `bolt12`, and `onchain`.
_Avoid_: Default method, native method

**Generic Payment Method**:
A base quote struct compatible payment method that a mint advertises but coco does not model as a
Built-in Payment Method. Generic Payment Methods preserve the mint's method string; their mint
quotes are reusable, locked to a wallet-controlled quote key, and claimable according to the paid
amount that has not yet been issued.
_Avoid_: Runtime payment method, custom payment method

**Payment Method Handler**:
A method-specific or generic implementation of coco's quote-backed payment lifecycle. Built-in
payment methods use dedicated handlers; Generic Payment Methods use generic mint and melt handlers
while preserving the advertised method string.
_Avoid_: Payment plugin, method switch

**Quote-backed Operation**:
A wallet operation whose local lifecycle is anchored to a mint quote. Payment methods can vary in
quote parameters and endpoint fields, but quote-backed minting and melting share the same durable
saga shape for outputs, inputs, proof state, and recovery.
_Avoid_: Method flow, payment workflow

**Quote Observation**:
A mint response that reports the current remote state of a quote and is recorded into Coco's
canonical quote row before any Quote-backed Operation is advanced from it.
_Avoid_: Quote refresh, subscription update

**Quote Identity**:
A methodless reference to a mint or melt quote by mint URL and quote ID. Mint quote identities and
melt quote identities are separate namespaces.
_Avoid_: Canonical quote ID, quote snapshot ID

**Payment Method Capability**:
A mint-advertised statement that a payment method supports a unit for minting or melting. Coco
derives payment method capabilities from NUT-04 and NUT-05 mint metadata.
_Avoid_: Payment option, method support flag

**Melt Quote State**:
The mint's settlement state for a melt quote. `PAID` is terminal, while `PENDING` can return to
`UNPAID` when settlement fails; a newer `UNPAID` observation can therefore be more accurate than an
older `PENDING` observation.
_Avoid_: Payment status, melt lifecycle

**Mint Quote Claimability**:
Whether a mint quote currently has paid value that coco can claim into proofs. BOLT11 mint quotes
are claimable when their state is `PAID`; reusable mint quotes are claimable when their paid amount
exceeds their issued amount.
_Avoid_: Mint quote paid state, payment status

**Mint Quote Payment Observation**:
A newly observed increase in paid value for a mint quote. It is distinct from Mint Quote
Claimability because reusable mint quotes can already be claimable before another payment arrives.
_Avoid_: Mint quote paid state, payment status

**Quote Expiry**:
The time after which a quote can no longer receive a new payment. Expiry does not prevent claiming
value that was already paid before expiry.
_Avoid_: Claim deadline, quote invalidity

**Background Watcher**:
A session-scoped automatic observer that keeps wallet state progressing without a direct caller
waiting on a specific result. Disabling a Background Watcher does not disable explicit caller
operations for the same domain work.
_Avoid_: Subscriptions, processors

**Restore**:
The act of reconstructing a wallet's proofs for a mint from the wallet's deterministic secrets and the mint's state. Restore is distinct from operation recovery and does not create a persistent restored state.
_Avoid_: Recovery, import, restored mint, restored wallet

**Operation Recovery**:
The act of reconciling persisted in-flight wallet operations after interruption so local operation state, proof state, and mint state agree again.
_Avoid_: Restore, restart, resume
