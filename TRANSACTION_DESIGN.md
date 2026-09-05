# Transaction Design

Status: accepted ([ADR-0011](packages/core/docs/adr/0011-use-domain-transaction-gateways.md)).

## Ownership and effects

The composition root owns `RepositoryCoreTransactionRunner`. Each `CoreMintTransactions` method
opens one strong adapter transaction, constructs `RepositoryMintCommands` from its short-lived
`RepositoryTransactionScope`, and returns only after commit. Transaction conflicts retry the entire
command at most three times with the same stable inputs.

`MintOperationService` owns preflight, request preparation, remote submission, recovery ordering,
and post-commit events. Its dependencies are read-only operation/proof/recovery Queries, a narrow
Quote Access interface, `MintRemote`, its own `MintTransactions`, and an event publisher. The
coordinator never receives repositories, a transaction scope, or a runner.

The scoped commands receive repositories from the same already-open scope. They cannot open a
transaction, call Services, perform mint I/O, emit live events, or retain their scope after return.
`derive(counter)` is synchronous SDK output derivation bound to preloaded seed/keyset material;
it performs no I/O. Authoritative quote, trust, sibling, counter, and recovery reads happen inside
the transaction. Informational reads outside it never authorize a write.

This slice builds on the strong repository transaction foundation merged in PR #460. It does not
require the separate keyring migration in PR #461. Other operation coordinators remain outside
this slice; they must follow this contract when migrated. Do not add scoped clones of Services or
an optional scope argument that opens a transaction when omitted.

## Mint commands

| Command         | Atomic result                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`       | Check canonical identity and trust; derive outputs at the authoritative counter; persist counter, pending operation, and no-submission provenance                               |
| `migrate`       | Establish recovery provenance for every sibling; move legacy pending work with unknown submission history to executing; clean up legacy init intent without reclaiming counters |
| `authorize`     | Repeat claimability and identity checks; commit the exact ordered payload, signature variants, accounting baseline, revision, executing state, and full reservation             |
| `applyEvidence` | Validate attribution and merge receipts; save usable or spent proofs and finalize only on complete evidence, in the same transaction                                            |
| `reject`        | Conditionally record rejection for the currently authorized transmission; persist a legacy signature variant or terminal failure only when no earlier ambiguity exists          |
| `noteAmbiguity` | Conditionally retain the submitted operation, payload, and full reservation with a diagnostic                                                                                   |

Missing recovery metadata on old pending/executing siblings is an unresolved commitment, even before
migration. Admission migrates the whole sibling set atomically. Historical finalized/failed rows
retain their outcomes; migration never fabricates receipts or repairs historical misclassification.

Revisions fence negative conclusions and transmission ownership. Only the caller that commits an
authorization may transmit it. Another coordinator or a restarted session performs Restore. A valid
late response may contribute exact evidence in a new transaction even if another worker advanced
the revision; it cannot replace the operation's outputs or overwrite a terminal outcome.

## Accounting baseline

Local completed issuance is a cumulative floor consisting of finalized operation amounts plus a
persisted baseline of earlier observed issuance. With no unresolved local sibling, authorization can
advance that baseline to `max(previousBaseline, remoteIssued - finalizedOperationAmounts)`.
With an unresolved sibling, retain the previous baseline: the remote total may already include that
sibling's output signatures. Claimability subtracts other unresolved reservations from
`max(0, paid - max(remoteIssued, localCompletedFloor))`.

For example, remote 100 paid / 40 issued, followed by one local 60 issuance, establishes a baseline
of 40 and a completed floor of 100. A stale remote total of 40 cannot authorize another 40. The
baseline is independent of the outcome of later concurrent sibling requests: a definitively failed
request does not leave a permanently reserved amount. This remains conservative accounting;
aggregate totals cannot attribute concurrent external-wallet issuance to local outputs.

## Evidence and spendability

The internal versioned Mint recovery sidecar contains the exact request, rejected signature variant,
monotonic revision, provenance, accounting baseline, and validated per-output receipts. Amounts use
lossless decimal strings. No private key is stored there. Do not expose this sidecar in public
operation results or logs.

Partial receipts retain the full executing reservation and stay in the sidecar. Complete evidence
finalizes issuance. `UNSPENT` proofs can enter ready storage; `SPENT` proofs remain spent. Unknown
and `PENDING` proof states stay in the sidecar, outside ready balance, and startup recovery checks
them again. Existing proofs are never re-credited or overwritten over a later spending operation.

NUT-09 empty Restore, quote-wide issued totals, quote expiry, and request-cache TTL are not
cancellation evidence. This implementation has no supported-mint concurrency allowlist, so it does
not automatically replay an ambiguous request. A crash between authorization and transmission can
therefore leave an unresolved operation with no recoverable signatures. Retaining its commitment is
the explicit conservative fallback; a later implementation may add replay only with a verified
remote duplicate-request contract.

The SDK public `prepareMint` quote-reference input and `completeMint` preview provide the request
seam. Coco persists every signature variant and omits SDK automatic legacy fallback at submission.
Only a definitive 20008 rejection of the first authorized transmission can authorize the stored
legacy signature. Recovery never generates new outputs, enlarges an amount, or guesses a signature.

## Storage and deployment

Memory, shared SQL, and IndexedDB repositories expose `mintRecoveryRepository` in both root and
transaction scopes. SQL migration 039 adds its table; IndexedDB version 34 adds its store. The SQLite
runtime bindings inherit the shared SQL implementation. Schema migration preserves operation rows
and output counters. Provenance migration is idempotent and happens before quote admission.

Upgrade all core/adapter packages together and stop all older writers before opening the upgraded
Wallet. IndexedDB schema versions reject old-version opens. SQL cannot retroactively prevent an
already-running old binary from writing: exclusive deployment is a required application policy.
Mixed-version writing and downgrade after using this schema are unsupported. Custom storage
adapters must implement the new repository contract; no memory-only fallback is permitted.

## Events and verification

Live events remain best-effort and are published after commit. Listener errors are logged without
rolling back a successful Wallet change or replaying a remote effect. A process crash after commit
can still lose an event; an outbox is outside this change.

Verification covers real SDK requests and signature compatibility, partial/empty/malformed Restore,
spent and held proofs, late responses, concurrent authorizers, baseline accounting, old sibling
migration, and rollback of allocation and finalization. Shared adapter contracts cover lossless
sidecar round-trips and grouped operation/proof/counter/evidence rollback on every adapter.
