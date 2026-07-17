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

**Payment Method Handler**:
A method-specific implementation of coco's quote-backed payment lifecycle. Built-in payment
methods use dedicated handlers.
_Avoid_: Payment plugin, method switch

**Quote-backed Operation**:
A wallet operation whose local lifecycle is anchored to a mint quote. Payment methods can vary in
quote parameters and endpoint fields, but quote-backed minting and melting share the same durable
saga shape for outputs, inputs, proof state, and recovery.
_Avoid_: Method flow, payment workflow

**Mint Operation**:
A Quote-backed Operation for one mint quote. It remains individually observable when issued alone
or together with other Mint Operations.
_Avoid_: Mint request, mint batch member

**Successful Mint Operation**:
A Mint Operation for which Coco possesses the exact proofs attributable to its issuance attempt.
A remotely issued quote without those proofs is a terminal failure because another wallet may have
redeemed it.
_Avoid_: Issued quote, completed mint

**Mint Issuance Attempt**:
One atomic effort to turn one or more eligible Mint Operations at a single mint into wallet proofs.
Its members share the same issuance and recovery outcome.
_Avoid_: Mint Operation, quote claim

**Mint Batch**:
A multi-operation Mint Issuance Attempt performed through NUT-29. It is an internal execution unit;
users continue to interact with its individual Mint Operations.
_Avoid_: User batch, quote group

**Quote Observation**:
A mint response that reports the current remote state of a quote and is recorded into Coco's
canonical quote row before any Quote-backed Operation is advanced from it.
_Avoid_: Quote refresh, subscription update

**Attributable Quote Observation**:
A Quote Observation whose quote identity and method-specific fields safely bind it to exactly one
requested canonical quote. Coco may record an Attributable Quote Observation from a successful but
otherwise off-protocol batch-check response; an atomically rejected request produces no
observations.
_Avoid_: Valid batch response, positional quote result

**Explicit Quote Check**:
A caller-scoped request to observe one canonical quote immediately. It is target-isolated and does
not recruit Background Watcher interests or join multi-quote watcher work.
_Avoid_: Foreground batch, priority watcher check

**Quote Identity**:
A methodless reference to a mint or melt quote by mint URL and quote ID. Mint quote identities and
melt quote identities are separate namespaces.
_Avoid_: Canonical quote ID, quote snapshot ID

**Payment Method Capability**:
A mint-advertised statement that a payment method supports a unit for minting or melting. Coco
derives payment method capabilities from NUT-04 and NUT-05 mint metadata.
_Avoid_: Payment option, method support flag

**Payment Request P2PK Requirement**:
A receiver-declared payment request condition requiring the payer to deliver ecash locked to a
NUT-11 P2PK spending condition. Coco uses it while satisfying a NUT-18 payment request as the
payer, not while creating an incoming payment request.
_Avoid_: Payment request key, P2PK target, payment request pubkey

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
