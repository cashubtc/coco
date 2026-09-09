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

**Wallet Recovery Material**:
A human-portable secret representation from which a Wallet Seed can be reconstructed. Cocod
currently represents it as a BIP39 mnemonic.
_Avoid_: Wallet Seed, passphrase, Client Credential

**Wallet Import**:
Initializing a Wallet from existing Wallet Recovery Material. Wallet Import establishes the Wallet
before Coco Restore reconstructs its proofs.
_Avoid_: Restore, new Wallet creation

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
A wallet operation whose local lifecycle is anchored to one or more mint quotes. Payment methods
can vary in quote parameters and endpoint fields, but quote-backed minting and melting share the
same durable saga shape for outputs, inputs, proof state, and recovery.
_Avoid_: Method flow, payment workflow

**Mint Operation**:
A durable, individually observable intent to claim value from one Mint Quote. Its outcome appears
as one mint history entry.
_Avoid_: Mint request, quote state

**Batch Mint Operation**:
A durable aggregate intent to atomically claim value from an exact group of two or more compatible
Mint Quotes through one issuance outcome. It appears as one aggregate mint history entry rather
than one Mint Operation per quote.
_Avoid_: Mint Operation parent, Mint Batch Attempt, transparent batch

**Batch Mint Member**:
An ordered allocation of an amount from one canonical Mint Quote within a Batch Mint Operation. It
is not a child operation and does not have an independent operation outcome.
_Avoid_: Child Mint Operation, batch item, quote owner

**Quote Observation**:
A mint response that reports the current remote state of a quote. Coco may accept, merge, or ignore
it against the canonical quote row before any Quote-backed Operation is advanced from it.
_Avoid_: Quote refresh, subscription update

**Remote Quote Update Time**:
The mint-reported Unix timestamp, in protocol seconds, at which a quote last changed remotely. It is
distinct from Coco's local canonical quote row update time.
_Avoid_: Updated at, row timestamp

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
Whether Mint Quote Accounting leaves paid value that Coco may claim into proofs after accounting
for completed local issuance and Mint Quote Reservations. BOLT11, BOLT12, and on-chain quotes
use the same balance rules; the payment request amount does not determine every claim amount.
_Avoid_: Mint quote paid state, payment status

**Mint Quote Accounting**:
The mint-reported cumulative amounts paid toward and issued from a Mint Quote. It is an input to
Mint Quote Claimability, not claimability by itself.
_Avoid_: Quote state, claimable amount

**Mint Quote Payment Observation**:
A newly observed increase in paid value for a mint quote. It is distinct from Mint Quote
Claimability because reusable mint quotes can already be claimable before another payment arrives.
_Avoid_: Mint quote paid state, payment status

**Mint Quote Reservation**:
Paid value from a Mint Quote committed to an issuance whose outcome remains unresolved. A Mint
Operation known never to have been submitted does not reserve value; an Ambiguous Operation Outcome
retains its full reservation.
_Avoid_: Remote issued amount, proof reservation, quote ownership

**Quote Expiry**:
The payment deadline advertised by a quote. For a Mint Quote it is advisory metadata for initiating
new payments, not a determinant of Mint Quote Claimability, issuance, Operation Recovery, or Quote
Observation.
_Avoid_: Claim deadline, quote invalidity

**Background Watcher**:
A session-scoped automatic observer that keeps wallet state progressing without a direct caller
waiting on a specific result. Disabling a Background Watcher does not disable explicit caller
operations for the same domain work.
_Avoid_: Subscriptions, processors

**Restore**:
The act of reconstructing a wallet's proofs for a mint from the wallet's deterministic secrets and the mint's state. Restore is distinct from operation recovery and does not create a persistent restored state.
_Avoid_: Recovery, Wallet Import, restored mint, restored wallet

**Operation Recovery**:
The act of reconciling persisted in-flight wallet operations after interruption so local operation state, proof state, and mint state agree again.
_Avoid_: Restore, restart, resume

**Exact Operation Request**:
Immutable mint request material owned by a durable operation and reused for both initial submission
and Operation Recovery.
_Avoid_: Retry request, regenerated request, execution attempt

**Ambiguous Operation Outcome**:
An operation outcome for which Coco cannot prove whether its Exact Operation Request affected the
mint. The operation retains its locally owned resources until Operation Recovery establishes a safe
result.
_Avoid_: Failed operation, timed-out operation

**Output Allocation**:
A durable commitment of deterministic counter positions to planned Cashu outputs. Output derivation
inside a transaction that does not commit is not an Output Allocation.
_Avoid_: Output generation, tentative outputs, counter increment

**Keypair Allocation**:
A durable commitment of one purpose-specific Wallet derivation index and its derived keypair. Key
derivation inside a transaction that does not commit is not a Keypair Allocation.
_Avoid_: Key generation, tentative key, high-water-mark increment

**Mint Issuance Evidence**:
Validated evidence that a Mint Operation's exact outputs were signed. It proves issuance independently
of whether the resulting proofs are currently spendable.
_Avoid_: Quote state, available balance
