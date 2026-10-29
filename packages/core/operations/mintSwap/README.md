# Mint Swap coordinator and runtime

This internal coordinator composes the persisted parent lifecycle through the shared Wallet
transaction runner. Manager wires it to `ops.mintSwap`, shared child locks and the independently
configured recovery processor. The coordinator itself stays outside package entry points. See the
[public API contract](../../README.md#mint-swap-operations). Parent history and React hooks remain #420.

The API is always available; initial source payment requires an explicit `execute` call.
Automatic parent recovery is enabled by default. The processor setting can disable automatic
parent startup/resume passes and timers while leaving all explicit commands available.

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
remote fencing. Cocod and React keep their existing host/session guards; no new universal lock
provider is required. While the parent is active, it exclusively coordinates its children; see
[Transaction Design](../../../../TRANSACTION_DESIGN.md) for how ordinary commands, processors and
recovery treat them.

The processor uses a 1-second due cadence and a 30-second complete active sweep, yielding every 25
attempts. Complete sweeps observe prepared parents and visit the entire eligible snapshot so a busy
prefix cannot starve the tail. Eligibility is rechecked under the parent lock. Events coalesce into
later scans, never inline reconciliation or retry-deadline changes. Stop invalidates callbacks and
drains current work; Manager disposal also drains admitted parent commands and aborts local waiters.
Parent quote interests use the same synchronous local declaration contract as ordinary operations.
Routing and all declarations are installed before progression without awaiting subscription setup.
Watchers own trust checks, acquisition failures, and late cleanup. Withdrawal revokes permission
immediately; parent stop and watcher stop wait for required cleanup, including late acquisition.
Repeated declarations and explicit watcher enable can retry failed setup without a new retry loop.

Normal scans consume cached canonical evidence. Startup prefers complete paid source evidence and
sufficient destination funding/completion accounting, but retains bounded recovery for unresolved
observations and an already-authorized destination's accounting. This is a temporary split: #559 moves
and narrows startup repair. Explicit refresh/recovery still observes immediately. Fresh source UNPAID
confirmation under the shared child lock remains required before releasing inputs.

Manager orders overlapping pause/resume requests and drains admitted lifecycle changes on disposal.
Do not await a lifecycle change from an awaited operation/lifecycle listener whose work it must drain.

`mint-swap:updated` is a minimal committed `{ operationId, revision, state }` hint, including initial
creation and same-state metadata changes. It is best effort and may reorder under reentrant listeners.
The outcome waiter uses local reads, read-subscribe-read, polling and a final timeout read. It never
performs remote recovery; timeout and attention are distinct from successful completion.

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

## Recorded slice 4 verification (before runtime activation)

- Workspace build and typecheck passed.
- Full Core unit suite: 1,953 passed, including 66 shared Mint Swap cases.
- SQL storage: 40 passed.
- Bun SQLite and SQLite3: 169 each (100 storage contracts plus 69 Mint Swap cases).
- Expo SQLite: 235 (97 existing contracts plus 69 Mint Swap cases for each native/web API shim).
- IndexedDB: 507 across Chromium, Firefox, and WebKit (100 storage contracts plus 69 Mint Swap
  cases per browser).
- Formatting and `git diff --check` passed.

Those verification runs selected the deterministic contract and composition suites. They do not
exercise native Expo devices or live Mint Swap payments. An earlier broad IndexedDB run encountered
68 live-mint integration failures because `http://localhost:3338` was unreachable; those tests were
not rerun as part of this coverage expansion.
