---
status: accepted
---

# Model batch minting as a standalone operation

Coco represents one NUT-29 issuance as a standalone Batch Mint Operation, not as a parent or
transport attempt over multiple Mint Operations. This keeps the existing single-quote Mint
Operation additive and unchanged while aligning aggregate output ownership, recovery, and history
with the protocol's atomic request.

## Considered Options

We rejected making a batch own child Mint Operations because the children could no longer honestly
own their outputs or independent outcomes. We also rejected transparent batching of already
prepared Mint Operations because concatenating their outputs would reduce HTTP calls without
optimizing the aggregate output split, while replacing their outputs would break their recovery
invariant.

## Consequences

A caller chooses between creating individual Mint Operations and one Batch Mint Operation before
output preparation. A future Background Watcher integration may make the same choice, but watcher
and processor changes are outside the initial feature scope. A Batch Mint Operation owns its
ordered quote claims, aggregate outputs and proofs, and one aggregate history outcome; it does not
create child Mint Operations.

The public interface is nested under `ops.mint.batch` and separates durable `prepare` from network
`execute`. It exposes `abort` before submission, direct lookup, in-flight and recovery access, and
lookup of every Batch Mint Operation containing a Quote Identity. Preparation persists exact
request material but performs no network submission. The initial API does not add a batch-specific
idempotency key; callers retain the returned operation ID, matching standalone mint preparation.

Public operation reads hydrate the separately stored members into their exact ordered `members`
array. Prepared and later operations also expose their serialized aggregate outputs and signed
NUT-29 request data, as standalone Mint Operations expose output recovery data, but never expose
Mint Quote private keys.

Each batch projects one aggregate `BatchMintHistoryEntry` with type `batch-mint`, total amount,
method, state, operation ID, and member count. This avoids inventing the singular `quoteId` and
`paymentRequest` required by `MintHistoryEntry`. It emits distinct `batch-mint-op:*` lifecycle
events. Its members remain queryable through the operation but do not create history entries or
reuse the single-operation `mint-op:*` event payloads. Any proof-shortfall diagnostic remains
attached to that aggregate history entry.

Membership consists of an exact caller-selected group of at least two canonical Mint Quote
references. Every requested amount must be claimable when the operation is admitted, and the group
must not exceed the applicable batch limit. The mint must advertise NUT-29 mint support for the
selected Built-in Payment Method; otherwise preparation rejects the request before creating an
operation or allocating outputs. An existing Mint Operation cannot be adopted by a batch, but a
reusable Mint Quote may support reservations from both operation types while its claimable balance
is sufficient.

Each ordered member records an explicit requested amount for a common mint, method, and unit.
Fixed BOLT11 members must allocate their quote's full amount; reusable BOLT12 and on-chain members
may allocate any positive amount within locally claimable balance. The batch lifecycle and
persistence model are common across every NUT-29-capable Built-in Payment Method, with
method-specific branching limited to irreducible validation and quote-key authentication.

Adapters persist each Batch Mint Member as a separately indexed value record containing its Batch
Mint Operation reference, ordinal, Quote Identity, and requested amount. The operation still owns
the aggregate request, recovery material, and outcome. Explicit preparation preserves caller order
exactly and rejects duplicate Quote Identities; canonical ordering is used only for lock acquisition.
Batch operations and members use a separate `BatchMintOperationRepository`; the existing
single-quote `MintOperationRepository` and its required fields remain unchanged.

A BOLT11 batch may mix unlocked members with Coco-owned NUT-20-locked members. Preparation signs
each locked member independently and persists those signatures, while an unlocked member needs no
signature. A missing or non-owned required key rejects the complete preparation before an
operation or outputs are persisted. Reusable BOLT12 and on-chain members retain their existing
Coco-owned quote-key requirement. Private keys are never stored with the operation.

Admission acquires every member's Quote Identity lock in stable order, re-evaluates Claimability
against reservations from both operation types, and atomically persists the complete membership.
If any member is ineligible, Coco admits no operation and allocates no outputs. Existing pending
Mint Operations do not reserve reusable quote balance; the first issuance to secure a reservation
wins, and later operations reassess against the remaining balance. Admission nevertheless counts a
pending single operation's requested amount as soft demand before allowing a reusable quote to
coexist in a batch, so the observed balance must currently cover both intents. This check does not
grant the pending operation a reservation or guarantee future capacity.

A fixed one-time BOLT11 quote with a nonterminal standalone Mint Operation is ineligible for batch
admission. Reusable quotes may coexist across operation types only under the soft-demand and active
reservation rules above.
