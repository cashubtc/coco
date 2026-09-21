# Receive transactions and recovery

Receive follows [Transaction Design](../../TRANSACTION_DESIGN.md). The public operation API stays
unchanged. New operations first become durable in `prepared`; `init` is a preflight draft, with
compatibility support for persisted legacy rows.

## Ownership of effects

| Boundary              | Owner                                 | Committed changes                                                                 |
| --------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| Metadata prerequisite | `MintService.refreshAndCommitIfStale` | Independently committed mint metadata; may survive later preparation failure      |
| Prepare               | `ReceiveTransactions.prepare`         | Signed inputs, fee, deterministic outputs, counter allocation, prepared operation |
| Authorize             | `ReceiveTransactions.beginExecution`  | Prepared → executing, revision increment                                          |
| Claim recovery        | `ReceiveTransactions.claimRecovery`   | Conditional executing revision increment before remote work                       |
| Apply issuance        | `ReceiveTransactions.applyResult`     | Missing proofs, conclusive spent-state updates, finalized operation               |
| Reject or cancel      | `failExecution` / `cancel`            | Conditional terminal state; committed counters remain consumed                    |
| Legacy cleanup        | `cleanupLegacyInit`                   | Delete only a row still in init                                                   |

Each gateway method opens one runner transaction. Receive composes shared scoped mint trust,
proof fee/reconciliation, and output allocation commands from that same adapter scope. These
modules receive neither Services nor a transaction opener. Authorizing reads occur inside the
transaction; the coordinator has only informational queries, its gateway, and explicit effects.

Preflight decodes the token, checks any input DLEQ through cashu-ts, signs P2PK inputs with existing
keys, removes input blinding data from the mint request, and loads the seed. The protocol adapter
submits the saved inputs and outputs through cashu-ts `Wallet.completeSwap`, preserving the same
wire ordering and witness normalization as legacy Receives. It unblinds with the output plan's
keyset, including inactive keysets. It never selects proofs, allocates
outputs, or reloads signing keys. Live events follow commit and release of the operation lock.

## Recovery evidence

A failed HTTP request does not establish whether the mint issued this operation's outputs.
Neither does a rejection of a later replay. The operation's exact request remains immutable.

| Evidence                                                                       | Action                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| All expected outputs already stored with this operation as creator             | Finalize locally, retaining their current spending and reservation state                                       |
| Every input is unspent                                                         | Replay the saved request                                                                                       |
| Replay rejected                                                                | Reobserve inputs; never fail solely from the replay error                                                      |
| Every input is spent, matching outputs restored                                | Combine verified candidates with local outputs and finalize only when the complete allocation is accounted for |
| Every input is spent, well-formed empty Restore, no local output               | Conditionally roll back this Receive                                                                           |
| Missing, malformed, pending, mixed input states, or incomplete output evidence | Retain executing and its recovery material                                                                     |

[NUT-07](https://github.com/cashubtc/nuts/blob/main/07.md) observations must cover every requested Y
in order. [NUT-09](https://github.com/cashubtc/nuts/blob/main/09.md) replies must pair each signature
with a requested blinded message; duplicates, foreign outputs, and amount/keyset mismatches are
errors, never evidence of absent issuance. Recovered output states may mix spent and unspent;
spent outputs are recorded as spent. Pending outputs defer completion.

A narrow set of request-validation errors can fail the first submission. This write requires the
original authorization revision. A recovery claim invalidates that authority before it can replay
the request. A valid positive result can still settle after a newer claim, because every claimant
uses the same request. Competing terminal transitions cannot overwrite one another.

Proof reconciliation checks signed identity before reusing a local proof. It preserves later
reservations and never turns spent proofs back into ready proofs. An unowned proof from Wallet
Restore needs matching remote evidence before it can complete Receive. A conflicting creator or
signature retains the operation for investigation. Repeated terminal application never recreates
proofs removed after completion.

## Compatibility and limits

SQL adds a revision column only if absent, retaining databases from earlier development migrations.
IndexedDB defaults missing revisions to zero without a schema version change for a non-indexed
field. Memory repositories isolate nested request values on writes and reads. Legacy init promotion
uses authoritative stored data; abandoned init cleanup cannot delete a prepared operation.

Payment Request Receive commits the child before linking the attempt. A failed link preserves the
validating attempt; recovery locates that child by source attempt ID and links it before execution.
Parent/attempt/child atomicity remains owned by the later Payment Request migration. Incoming token
proofs are not locally reserved; the mint resolves competing receives. Legacy Mint/Melt counter
writers still share the session's mint lock until their migrations. Live events remain best effort;
this change adds no durable outbox or uniform nested-transaction rejection.

Behavior tests exercise real gateways with memory and SQLite, including interrupted grouped writes,
independent connections, late rejection races, immutable replay, partial legacy saves, and post-commit
listener failure. Protocol tests use real Cashu blinding/unblinding and inspect submitted requests.
The adapter contracts cover conditional revisions, nested snapshot isolation, and grouped rollback.
