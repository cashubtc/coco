# Mint Swap coordinator — slice 4

This internal module implements the persisted parent lifecycle on the current coordinator-owned
transaction design. It is deliberately absent from package entry points and Manager wiring. The
existing public Mint Swap path is unchanged. #419 owns runtime/API activation and shared-session
wiring; #420 owns parent history, React, and user documentation.

`prepare(intent)` requires a stable parent ID, distinct trusted source/destination mints, a positive
exact receive amount in sat, and an optional conservative source debit cap. It allocates a committed
NUT-20 key before creating the locked BOLT11 destination quote, creates the source quote for that
exact invoice, and persists immutable parent/child identities before reserving proofs. Both child
plans and the prepared parent then commit in one transaction.

`execute(id)` explicitly authorizes a prepared source. A pre-swap checkpoints its exact outputs
before payment. `reconcile(id)`, `recoverActive()`, and `recoverDue()` observe and recover existing
work; they never initiate payment for an untouched prepared parent. Source recovery never blindly
redispatches payment after a crash. An independently advanced exact child is adopted through the
normal parent state edges.

The coordinator requires the same source and destination `OperationIdLock` instances used by their
ordinary child services, and the shared `MintScopedLock`. Locks are acquired outside transactions.
Only one Coco Session may drive effects for a Wallet store. These locks do not provide cross-process
remote fencing. Multiple read-only sessions remain a separate host concern.

## Economic evidence

For reserved original inputs R, pre-swap keep K, exact Melt inputs M, pre-swap fee Fs, destination
amount A, and verified change C:

- R = K + M + Fs.
- Minimum debit = A + Fs + the NUT-02 input fee on M.
- Maximum debit = R - K; an expected refund cannot make the request fit its cap.
- Returned = K + C; final debit = R - returned = A + total fee.

Cancellation before authorization releases the reserved source inputs. After authorization it records
intent until fresh non-payment evidence and child release establish a safe exit. If a pre-swap
already succeeded, its fee can remain consumed. A paid source always proceeds toward destination
recovery or needs_attention, never cancelled/failed.

Destination completion requires canonical amountIssued and the exact stored proof total to equal A.
Proofs already spent or reserved by another operation still count as historical issuance evidence;
their state is preserved. Lagging accounting keeps the parent destination_pending after local child
finalization. Incomplete restoration retries; missing immutable recovery material or concrete
contradictions stop automatic work in needs_attention.

## Transaction review

- Only the coordinator opens `run`; parent transitions compose child transitions via `tx.perform`.
- Parent revision guards, both children, proofs and counters share one active adapter scope.
- A lost parent guard throws and rolls back earlier child writes.
- Remote handlers, seed loading, metadata/quote workflows, locks, clock/RNG sampling and events
  stay outside retryable attempts. Scoped derivation remains synchronous.
- Settlement composes child proof mutation with parent progress; semantic parent contradictions
  retain valid child settlement and produce bounded attention evidence.
- Event snapshots are read in scope, returned after commit, and published after child/parent locks
  release. Listener failure does not replay remote effects. There is no outbox.
- Retry scheduling uses one fixed random sample per attempt, full jitter, monotonic timestamps,
  and a Retry-After lower bound. Due scans recheck current due time after acquiring the parent lock.

The repository-local suites in `packages/adapter-tests/src/internal/mintSwap` exercise the same 66
coordinator and composition scenarios on Memory, Bun SQLite, SQLite3, Expo SQLite's native/web API
shims, and browser IndexedDB. Persistent adapters add three cases that close and reopen the physical
store without reseeding it: delayed PAID, delayed UNPAID, and lost destination issuance responses.
These helpers are absent from published entry points. Protocol responses are deterministic doubles;
the persistence and transaction runners are real.

Coverage includes prerequisites and debit caps, independently committed NUT-20 allocation, nonzero
input fees and Melt change, parent/child/proof/counter rollback, retry replay, dropped transitions and
expired scopes, child locks, cancellation races, retained recovery material, historical proof ownership,
bounded backoff without retry exhaustion, and events delivered after commit and lock release.
All 39 original scenarios remain in the shared suites. Core runs the Memory cases; SQLite cases now
run in their adapter packages. The SQL adapter CI jobs explicitly include `mintSwapComposition.test.ts`;
the IndexedDB job already runs every browser test file through `test:browser`.

## Local verification

- Workspace build and typecheck passed.
- Full Core unit suite: 1,953 passed, including 66 shared Mint Swap cases.
- SQL storage: 40 passed.
- Bun SQLite and SQLite3: 169 each (100 storage contracts plus 69 Mint Swap cases).
- Expo SQLite: 235 (97 existing contracts plus 69 Mint Swap cases for each native/web API shim).
- IndexedDB: 507 across Chromium, Firefox, and WebKit (100 storage contracts plus 69 Mint Swap
  cases per browser).
- Formatting and `git diff --check` passed.

The current verification runs select the deterministic contract and composition suites. They do not
exercise native Expo devices or live Mint Swap payments. An earlier broad IndexedDB run encountered
68 live-mint integration failures because `http://localhost:3338` was unreachable; those tests were
not rerun as part of this coverage expansion.
