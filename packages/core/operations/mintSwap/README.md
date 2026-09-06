# Dormant Mint Swap V1 foundation

This module defines an exact-receive, `sat`, BOLT11 parent saga between two distinct trusted mints.
It contains the persisted model, parser, transition policy and feature-owned persistence contract.
There is no coordinator, API, processor, event, or initialization change. The memory implementation
is internal and is not installed in `MemoryRepositories`.

The execution source of truth is [the #402 checklist](../../../../MINT_SWAP_PR_402_TODO.md), with
the [resolved specification](../../../../docs/research/366-mint-swap-saga-foundation/implementation-specification.md)
providing the design and downstream boundaries.

## Persisted facts and validation

- Parent references point to exact preassigned Mint/Melt child IDs. Child modules have no parent
  knowledge. Quote and child identities use separate source Melt and destination Mint namespaces.
- `preparing` already has both canonical quotes and precedes either child's preparation. Quote/key
  orphans before this checkpoint are value-neutral. No child planning framework is added.
- `parseMintSwapOperation(unknown)` checks every state and reconstructs independent snapshots.
  Amounts accept cashu-ts `Amount`, nonnegative integer numbers/bigints, or decimal strings; amounts
  larger than the safe-number limit must use strings/bigints. A SHA-256 invoice digest is a lowercase
  64-character hex string. Binary hydration accepts 32-byte `Uint8Array` or integer-array input and
  returns that same canonical hex representation. No child keys, outputs or proofs belong here.
- Unknown fields, unbounded error messages, and state-inappropriate facts are rejected. Retry codes
  are a closed vocabulary matched to waiting/transient/ambiguous categories. Attention stores a
  reason, invariant and code/leg/observation time, without copying sensitive remote data.
- `lastSafe` is a non-recursive checkpoint of the previous nonterminal state and its established
  progress facts. Its state, entry time, bounds, authorizations and settlement cannot be invented or
  rewritten during a transition into a value-neutral exit or `needs_attention`.
- Cancellation is a write-once request committed in `preparing`, `prepared` or `source_pending`.
  A later `cancelled` transition requires that persisted request plus value-neutral evidence. A
  request remains historical intent after payment. `source_pending` can exit only with confirmed
  `UNPAID` and released proofs; neither time nor retry exhaustion is that evidence.
  A `prepared` checkpoint already establishes a reservation, so it also requires released proofs.
- Parent-local accounting validates debit bounds, cap, net debit, total fees and exact completion
  totals. It cannot prove the referenced children or proofs exist: #418 must re-derive these facts
  from the canonical child/quote/proof records before each economic transition.

## Conditional writes and scheduling

`create` requires revision zero and atomically claims five all-time identities: parent ID, source
quote tuple, destination quote tuple, source child ID, and destination child ID. Quote keys are
`(normalized mint URL, bolt11, quote ID)` in their respective Mint/Melt namespaces. No deletion or
blind `update` path can free an identity or bypass transition validation.

`transition({ operationId, expectedState, expectedRevision, next })` first matches all three guards.
Missing/stale guards return `false` without interpreting `next`. On a match, persistence overwrites
the candidate's revision with `expectedRevision + 1`, parses it, and applies
`validateMintSwapTransition`. Invalid candidates and unsafe increments throw without mutation.
Same-state metadata updates advance revision once. Public commands in #419 must never expose an
expected revision; that is an internal persistence guard.

All local times are safe, nonnegative Unix milliseconds. Writers clamp new timestamps against the
previous persisted update time. Same-state writes preserve `stateEnteredAt`; state changes set it to
the new `updatedAt`. Established authorization, settlement and completion times remain immutable.
Terminals and attention accept no transitions in V1.

Unsuccessful attempts in automatic states persist a count, last attempt time, scheduled retry, and
typed error. Each state change resets the count and error. On entry, `preparing`, `source_pending`,
`destination_funded` and `destination_pending` are immediately due. `prepared`, terminals and
attention have a null due time. `listDue(now, limit)` includes due times equal to `now`, ordered by
due time, creation time, then raw ID order. `listActive()` includes prepared and attention and orders
by creation time, then ID. Both queries return parsed defensive copies.

The memory repository has a synchronous check-and-write mutation boundary with no intervening
`await`. It guarantees one concurrent winner within that repository instance. It does not provide
cross-repository transactions or multi-runtime child fencing.

## #417 adapter handoff

- Persist the same model and use the parser on create, hydration and reads. Reuse the transition
  policy after assigning the revision; keep every rejected write mutation-free.
- Add unique indexes for parent ID and each of the four role-scoped identities above, plus
  state/revision and state/due scan indexes. Cover fresh schema and upgrade behavior.
- Expose `MintSwapPersistence` through an opt-in adapter capability and the existing Wallet
  transaction scope/module factory. A scoped repository must use the same physical transaction,
  connection, and lifetime as the child and proof handles; sharing only the database is insufficient.
- Do not open or commit a separate transaction from a scoped handle, and do not add a feature-owned
  transaction runner. The existing Wallet runner owns retries and rollback.
- Test atomic parent/child/proof commit and rollback, revision rollback, stale guards, concurrent
  uniqueness, ordering, and scoped-handle lifetime against the shared persistence contract.

## #418 coordinator handoff

- Add a Mint Swap domain gateway through the existing Wallet runner/module-factory pattern. Keep
  remote requests, wallet/key preflight, and post-commit events outside transaction callbacks.
- Require generic, idempotent child preparation using the preassigned operation ID and immutable
  input, with typed conflicts. Standalone children generate an ID then delegate to this seam. The
  children must not gain Mint Swap fields, repositories, ownership checks or phase methods.
- Consume #400's locked BOLT11 quote, cumulative accounting, monotonic observations, NUT-20 key
  ownership/signing and exact-output recovery. Require atomic key allocation (#461) before runtime
  preparation. The parent never stores public/secret keys or copies protocol state.
- Use short Wallet transactions for related local parent/child/proof changes, with remote I/O
  between committed saga checkpoints. Quote-only lookup remains diagnostic; exact child IDs are
  recovery authority.
- Reconcile before retrying ambiguous work. Persist `PENDING` and keep source proofs unavailable
  across repeated polls, lost events and restart. Delayed `PAID` requires verified settlement and
  forward recovery. Delayed `UNPAID` permits failure/cancellation only after child rollback and proof
  release. Destination recovery has no retry limit and completes only after exact proofs are stored
  and verified. Contradictory evidence enters quiescent `needs_attention`.
- Implement full-jitter waiting backoff (2 seconds to 5 minutes) and transient/ambiguous backoff
  (1 to 30 seconds), respecting server retry guidance as a lower bound.
- Inject every crash window and both delayed Melt outcomes with fresh services and events disabled.
  Enforce one active Mint Swap processor per store; parent revisions or leases do not fence child
  dispatch across multiple Managers.

#419 owns explicit activation, APIs, waiters and post-commit event hints. #420 owns history, React,
user documentation and release acceptance, including both delayed Melt outcomes. The #402 checklist
explicitly assigns the release changeset to #420; no activation/release announcement is added here.
