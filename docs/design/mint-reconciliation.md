# Shared Mint accounting and reconciliation

Status: **Implementation reference**  
Date: 2026-09-05  
Supersedes the implementation approach in [PR #480](https://github.com/cashubtc/coco/pull/480)
and the behavior-preserving scope of [issue #469](https://github.com/cashubtc/coco/issues/469).  
Evidence: [specification and implementation research](../research/mint-quote-reconciliation.md).

The replacement implementation follows this reference with the concrete decisions recorded in
[implementation choices](#18-implementation-choices). Accepted outcome and transaction contracts
are recorded in ADR-0012 and TRANSACTION_DESIGN.md. PR #480 is a source of reusable code and tests,
not a prerequisite to merge. The original issue's requirements to exclude BOLT11, preserve every
existing recovery outcome, and avoid persistence changes are explicitly superseded here.

Start with [legacy BOLT11 compatibility](#32-legacy-bolt11),
[claimability](#6-claimability-and-amount-selection),
[the reconciliation algorithm](#10-reconciliation-algorithm), and
[delivery](#16-delivery-sequence-and-pr-replacement). The storage and test sections specify the
work needed to make those rules reliable across restarts and supported adapters.

## 1. Outcome

Coco will use one accounting and reconciliation implementation for standalone BOLT11, BOLT12,
and on-chain Mint Operations. Payment method differences remain in quote creation, response
validation, and signing. Quote accounting determines which new claims Coco may authorize;
evidence for an operation's exact outputs determines whether that operation was issued.

For automatic BOLT11 claiming, Coco requests the full currently available value, subject to mint
limits and local reservations. A normal paid 100-sat invoice still produces one 100-sat claim.
Coco does not deliberately divide that claim into smaller claims. If a mint reports 100 paid and
40 already issued, the remaining 60 is valid accounting and may support a new 60-sat claim.
An existing 100-sat operation is never silently resized to fit that observation.

Successful delivery means:

- all three methods use the same claimability, exact-output reconciliation, and error decisions;
- legacy BOLT11 responses retain their normal full-amount behavior;
- an uncertain submitted operation retains its request and reservation across crashes;
- issued proofs are distinguished from proofs that remain spendable;
- an operation cannot finalize merely because its quote was issued somewhere;
- persistence commits the evidence, proof changes, reservation settlement, and outcome together;
- tests exercise the installed SDK and storage contracts as well as Coco's own decisions.

This is a refactor with intentional behavior corrections. It must not be presented as a
behavior-preserving extraction or judged solely by net line count.

## 2. Why replace PR #480

PR #480 extracts the duplicated BOLT12/on-chain lifecycle into `ReusableMintLifecycle` and retains
method-specific wrappers. It reduces duplicated decisions in those two handlers, but preserves
existing differences that the specifications do not require:

| Current behavior                                                                                    | Replacement                                                            |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| BOLT11 partial accounting is invalid                                                                | Apply the common paid/issued accounting rules                          |
| BOLT11 recovery checks the quote before Restore                                                     | Use the same exact-output recovery order for all three methods         |
| BOLT11/BOLT12 can finalize after `ALREADY_ISSUED` with no saved proofs; on-chain takes another path | Apply one evidence-based completion rule                               |
| Restore returns only unspent proofs                                                                 | Preserve issuance evidence independently of proof state                |
| Ambiguous recovery can return to `pending` and release its reservation                              | Retain submitted ambiguity in `executing`                              |
| Saved deterministic outputs are reused, but the complete submitted payload is not retained          | Persist the request used for submission and replay                     |
| Handler tests replace Wallet issuance with mocks                                                    | Add SDK seam tests that expose expiry, balance, and signature behavior |

Useful parts of #480 include the typed method differences and its characterization tests. Keep the
creation tests and relevant output/identity tests. Replace assertions that deliberately preserve
unsafe or inconsistent outcomes with tests for this document's rules. Remove the reusable-only
lifecycle once the common implementation is wired; do not leave both implementations active.

## 3. Protocol basis and compatibility

### 3.1 Accounting is common; payment requests differ

Current NUT-04 defines paid/issued accounting for all three methods and permits issuance below the
available balance. NUT-23's fixed BOLT11 invoice amount does not add a standalone all-or-nothing
issuance requirement. NUT-25 and NUT-30 explicitly require acceptance of claims within available
balance. This describes the current specifications, not universal support in deployed mints.
[NUT-04][nut04], [NUT-23][nut23], [NUT-25][nut25], [NUT-30][nut30]

| Method   | Creation and payment differences                                                                 | Authentication                                                     |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| BOLT11   | Required invoice amount; normal single payment; legacy state responses remain supported          | Optional NUT-20 lock; preserve existing owned-key and lock options |
| BOLT12   | Optional offer amount and description; repeated payments; offer amount does not fix claim amount | Required NUT-20 public key                                         |
| On-chain | Address request with no creation amount; eligible deposits credited after confirmation           | Required NUT-20 public key                                         |

Keep method-specific validation of immutable quote identity, request, unit, and ownership. Validate
BOLT11's creation amount as invoice metadata; do not equate it with every later operation amount.
Keep BOLT12 requested offer-amount validation during creation/refresh. It must not constrain
issuance to that offer amount. Preserve fresh quote-key generation for the existing flows.

### 3.2 Legacy BOLT11

Continue to let cashu-ts normalize remote legacy responses. For a 100-sat invoice, the normal
compatibility mapping is:

| Legacy state | Canonical paid | Canonical issued | Automatic claim |
| ------------ | -------------: | ---------------: | --------------: |
| `UNPAID`     |              0 |                0 |            None |
| `PAID`       |            100 |                0 |             100 |
| `ISSUED`     |            100 |              100 |            None |

Preserve Coco's existing caller-import compatibility seam for snapshots that bypass cashu-ts;
do not introduce another remote wire normalizer. Do not fabricate timestamps for older responses.
Canonical observation resolution must keep versioned observations from regressing through stale
or conflicting legacy projections. Deprecated `state` is a compatibility projection, never the
source of truth when valid accounting is available.

Normal automatic claiming remains compatible with old full-only mints because it still asks for
100 after a full 100-sat payment. No partial-issuance capability flag is assumed: the reviewed
specifications provide no dedicated flag on which to base such a decision. A mint reporting
partial accounting is not thereby proven to accept every subsequent request.

Do not add a new public chunk-size or partial-issuance API. The existing explicit `prepare` amount
remains the caller's exact intent; remove its equality-to-invoice-amount restriction. A deployed
mint may reject an explicit smaller claim, and Coco must surface and reconcile that rejection.
Backward compatibility here means unchanged normal legacy flows, not a promise that old mints
support newly accepted explicit amounts. Never respond to a rejection by requesting already-issued
value, enlarging a claim to the original invoice amount, or fabricating accounting.

### 3.3 Expiry and evidence

Keep ADR-0008's rule that local Quote Expiry does not block funded issuance or recovery. For
on-chain quotes, deposits first detected before expiry may become eligible after confirmation;
Coco uses the mint's credited accounting rather than attempting to reproduce its chain policy.
A remote expiry error must be interpreted in the context of all earlier submissions, not confused
with a local clock check. [NUT-23][nut23], [NUT-30][nut30], [error codes][errors]

NUT-09 provides evidence for specific signed outputs; NUT-07 reports their current proof states.
Quote totals identify neither those outputs nor their current spendability. NUT-19 can return a
cached response for an identical request, but a cache miss processes the request normally. It is
an optimization, not a durable exactly-once guarantee. [NUT-09][nut09], [NUT-07][nut07], [NUT-19][nut19]

## 4. Scope

Included:

- common accounting, selection, preparation, execution, and reconciliation for the three built-in
  standalone Mint methods;
- preserving complete request and issuance evidence through supported persistence adapters;
- durable authorization and result application for Mint Operations under ADR-0011;
- compatibility with old quote responses and existing persisted operations;
- SDK validation and exact-replay integration needed to implement these guarantees;
- affected history, event, diagnostic, and documentation semantics.

Excluded:

- Melt lifecycle refactoring or reuse of `BaseQuoteMeltHandler`;
- Batch Mint membership, aggregation, or changes to ADR-0010's batch-specific outcomes;
- Mint Swaps, payment backend implementation, chain monitoring, or fee selection;
- new public handler registration, a generic saga engine, or a broad service inheritance tree;
- a global rewrite of ProofService, watcher scheduling, or an event outbox;
- silent repair of old finalized history or a promise of mint-side exactly-once processing.

Quote discovery/filtering must recognize partially issued BOLT11 balances. That is included even
though scheduling and polling cadence remain outside scope. Operation Recovery must keep running
independently of whether a quote is still selected for ordinary payment observation.

## 5. Domain rules

Use the existing domain vocabulary, with the following changes proposed for the implementation PR:

- **Mint Quote Accounting** remains remote cumulative paid/issued value.
- **Mint Quote Claimability** uses common accounting and local commitments for all three methods.
  Remove the glossary's BOLT11 all-or-nothing qualification.
- **Mint Quote Reservation** covers a submitted or durably authorized operation whose issuance
  outcome is not settled locally. A payment-waiting operation does not reserve value.
- **Exact Operation Request** includes the ordered transport payload and recovery material needed
  to reproduce an authorized request. Output identity survives every retry and SDK upgrade.
- **Mint issuance evidence** is proposed terminology for retained validation evidence associating
  signatures/proofs with an operation's exact outputs. It survives later spending or proof cleanup.

The `reusable` quote property continues to describe payment request reuse for compatibility. It
must not choose an all-or-nothing versus balance issuance algorithm. Invoice amount, claim amount,
quote balance, and operation outcome are separate facts.

Zero available balance does not establish completion of a particular Mint Operation. Nor does it
mean a reusable quote can never receive more payments. Preserve any legacy quote-status projection
needed by callers while removing its authority over operation finalization.

## 6. Claimability and amount selection

### 6.1 Common calculation

Reject negative/malformed accounting at the normalization/import seam and reject `issued > paid`.
Do not reject a positive BOLT11 issued amount solely because it is smaller than the invoice amount.

For new authorization, use the accepted canonical quote and local facts for the same quote:

```text
P = canonical amountPaid
I = canonical amountIssued
F = local completed issuance floor (finalized operation amounts plus persisted issuance baseline)
R = amounts reserved by other unresolved authorized operations

remoteAvailable = P - I
localAvailable  = max(0, P - max(I, F) - R)
```

The persisted baseline accounts for issuance observed before local claims. For example, starting
at 100 paid / 40 issued, then finalizing a local 60 claim, must establish `F = 100`, not `F = 60`.
Otherwise stale remote accounting can incorrectly authorize another 40. Authorization advances the
baseline only when no unresolved sibling could already be represented in that observation; see the
[maintained baseline rules](../../TRANSACTION_DESIGN.md#accounting-baseline).

`max(I, F)` prevents counting the same observed issuance twice. Reservations can conservatively
understate availability when remote totals already include an unresolved operation; exact-output
reconciliation settles that reservation. Do not claim that aggregate totals alone can precisely
attribute overlap across other wallets or sessions.

Where a supported build also has Batch Mint Members or other quote commitments, `F` and `R`
must include their existing contributions through the shared quote-accounting seam. Sharing these
facts does not change batch recovery or its outcome policy. Standalone authorization cannot ignore
another supported operation merely because this refactor does not own that operation's lifecycle.

Partial output evidence stays within the operation's full unresolved reservation until its outcome
is settled; do not also add it to `F`. An operation's own reservation is excluded when assessing
replay eligibility for that operation. New claims include every other unresolved reservation.

The calculation is shared pure logic. An informational query may use it outside a transaction;
the owning transaction repeats the authoritative reads before authorizing issuance. Selecting and
reserving must be one committed decision across concurrent Coco Sessions.

### 6.2 Selection policy

- Automatic claiming selects the greatest positive amount currently authorized by local availability
  and advertised operation limits. Leave value below minimum limits waiting. If a maximum limits
  the claim, leave the remainder for later bounded processing; never resize an existing request.
- Explicit preparation retains the caller's positive amount. Preparation may occur before payment;
  availability is checked during authorization, not treated as a prerequisite for saving intent.
- Once an operation has its persisted output plan, its amount and outputs are immutable, including
  while `pending`. `execute(id)` never changes them to fit a later balance.
- Quote-level automatic processing reconciles submitted operations first. Existing fitting pending
  operations may be authorized under the established selection policy. With `autoClaimRemaining`
  enabled, any additional claim uses a distinct operation ID and fresh output positions.
- An older pending 100-sat intent that no longer fits a 60-sat balance remains pending with an
  insufficient-availability diagnostic. Automatic processing may create a separate 60-sat operation
  under the configured policy; it must not present that as successful execution of the 100-sat ID.
- An unresolved submitted 100-sat request is different: its reservation remains in force and may
  leave no value available for a new claim until reconciliation establishes what happened.

For legacy BOLT11 this policy naturally selects the full invoice value. Treat explicitly reported
partial accounting as usable evidence, without treating legacy state normalization as evidence of
a partial-issuance capability.

## 7. Module design and ownership

Use composition around the existing `MintOperationService`. Proposed names below locate
responsibilities; implementation may combine private helpers that share the same lifetime.

| Module or seam                                               | Responsibility                                                                                 | Effects/authority                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `MintQuoteClaimability`                                      | Common amount assessment                                                                       | Pure                                                                     |
| `MintReconciliation`                                         | Decide the next action from request, output evidence, prior attempts, and accepted quote facts | Pure; no endpoint, repository, or event calls                            |
| `MintOperationService`                                       | Order preflight, observations, committed transitions, remote submission/Restore, and events    | Application coordinator; own Mint transactions only                      |
| Method adapters                                              | Create/fetch/validate method-specific quotes and disclose signing requirements                 | Typed remote/local preflight; no operation outcome policy                |
| Mint remote adapter                                          | Submit a persisted request, inspect Restore responses, use cashu-ts validation/unblinding      | Remote I/O outside transactions; return evidence, not persisted outcomes |
| `MintTransactions`                                           | Prepare, authorize, record attempt evidence, and apply outcomes                                | Each command opens exactly one transaction                               |
| Scoped Mint commands and shared scoped proof/output commands | Validate and write operation, counter, reservation, evidence, and proof invariants             | One scope; no transactions opened, network calls, or live events         |
| Queries and signing/derivation capabilities                  | Load immutable facts, keys, mint metadata, and preflight material                              | Narrow disclosed effects; queries cannot allocate or repair              |

A conceptual internal result shape is:

```ts
type MintReconciliationDecision =
  | { action: 'finalize'; evidence: CompleteMintIssuanceEvidence }
  | { action: 'restore' }
  | { action: 'observe-quote' }
  | { action: 'replay'; request: PersistedMintRequest }
  | { action: 'wait'; reason: MintReconciliationReason }
  | { action: 'fail'; evidence: DefinitiveNonIssuanceEvidence };
```

This is a sketch, not a new public API or a generic state machine. Decision inputs must record which
observations have already been attempted so one recovery pass terminates rather than repeatedly
returning `restore` or `observe-quote`. Remote results are facts; only the owning transition settles
an operation. Do not use a method switch or `any` dispatch to choose recovery semantics.

Keep existing handlers as compatibility facades where current consumers require them, but delegate
all built-in lifecycle decisions to the common implementation. Their adapters may vary quote
creation and signing, not decide `FINALIZED`, `PENDING`, or `TERMINAL` independently. Audit public,
plugin, and declaration-merging surfaces before changing exported handler/context types. A custom
handler migration is not silently bundled into this built-in refactor.

## 8. Durable lifecycle and transactions

Retain the existing public states; define them more precisely:

| State       | Meaning under the replacement                                                                 |
| ----------- | --------------------------------------------------------------------------------------------- |
| `init`      | Persisted intent without committed output preparation                                         |
| `pending`   | Prepared immutable outputs; no unresolved submission; waiting for authorization/payment       |
| `executing` | Authorized request with a reservation; submission or recovery may still have an effect        |
| `finalized` | Complete validated issuance evidence is durably associated with the operation                 |
| `failed`    | Definitive non-issuance has been established for the operation; no unresolved earlier attempt |

A crash immediately after authorization can leave `executing` even if no bytes reached the mint.
Treat that as potentially submitted; a process-local flag is not durable evidence of non-submission.
A payment timeout, Restore failure, or expired worker lease does not permit `executing -> pending`.
A deliberate return to pending is allowed only after all attempts are proven non-issued and the
same immutable intent can safely wait again. Alternatively a definitively rejected intent can fail.

Required committed transitions:

1. **Prepare:** allocate deterministic output positions and save the matching pending output plan
   in one transaction. Derivation/keyset preflight happens outside; committed counter positions
   are never reclaimed. Apply shared scoped allocation under the Mint owner.
2. **Authorize:** re-read operation, quote, local evidence, and reservations; validate a preflighted
   payload matches the immutable plan; save the request, reservation, and `executing` state together.
   For automatic selection, reject/retry a candidate if availability changed during preflight.
3. **Begin transmission:** durably record the request variant/attempt and ownership revision before
   remote I/O. A restart treats an attempt without a conclusive result as ambiguous.
4. **Apply evidence:** validate operation/request identity again; merge durable output evidence;
   atomically settle the reservation and operation outcome when complete or definitively non-issued.
   Partial evidence is retained without ordinary completion.
5. **Publish:** emit events after commit. A failing listener cannot cause another issuance attempt.
   Existing best-effort delivery remains: a crash after commit can lose a notification, so persisted
   queries remain authoritative. This refactor does not promise an outbox or exactly-once events.

The effect order is:

```mermaid
flowchart LR
  A[Local and SDK preflight] --> B[Mint transaction: authorize and persist request]
  B --> C[Remote submission or Restore]
  C --> D[Validate returned evidence]
  D --> E[Mint transaction: merge evidence and apply decision]
  E --> F[Publish committed outcome]
```

A quote observation needed between these steps is recorded through canonical Quote Observation
resolution first; the authorizing/applying transaction rechecks the local facts it depends on.

Transitions use monotonic revisions or equivalent conditional writes. Two local workers must not
both authorize competing claims. Recovery ownership needs a bounded lease or an equivalent durable
claim; lease expiry permits another worker to recover the same request, never a different request
or release of its financial reservation. A stale worker may contribute valid exact-output evidence
through a fresh transaction, but cannot overwrite a newer outcome.

Follow [Transaction Design](../../TRANSACTION_DESIGN.md) and [ADR-0011][adr11]. No remote I/O inside
transactions, no nested application gateways, and no new legacy dependency exceptions. Shared
scoped allocation/proof commands may be extracted for this Mint slice without migrating every
ProofService consumer. Memory rollback behavior must satisfy the same contract as persistent
adapters before claiming atomicity.

## 9. Exact requests and issuance evidence

### 9.1 Proposed storage shape

Use an internal `MintRecoveryRecord` keyed by operation ID, transactionally coupled to the existing
Mint Operation. Prefer a dedicated repository/table or IndexedDB store over placing transport
payloads and proof receipts into public operation result objects. Keep the existing output plan as
its source of truth; reference/validate its digest rather than keeping mutable competing copies.

The versioned record needs:

| Data                                                           | Purpose                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Format version, revision, operation ID                         | Decode safely and reject stale writes                                    |
| Method, quote identity, unit, claim amount, output-plan digest | Bind recovery to the intended operation                                  |
| Persisted request payload and encoding/signature version       | Reproduce the submitted request across restart and upgrades              |
| Request variant IDs and attempt status                         | Distinguish a conclusive rejection from unresolved earlier transmissions |
| Validated per-output issuance evidence                         | Retain proof of issuance even after spendable proof cleanup              |
| Reservation/authorization facts and recovery ownership         | Prevent competing local claims and stale-worker transitions              |
| Structured diagnostic and observation provenance               | Explain partial, unavailable, or legacy-unknown evidence                 |

Store amounts losslessly using the repository's established amount encoding. Do not serialize SDK
class instances as a persistence format. Persist output ordering, keyset IDs, amounts, blinded
messages, and the selected signature payload exactly. Use an explicit versioned codec for the
SDK-compatible transport representation; credentials and quote private keys remain outside the
recovery record. Never log secret/output recovery material or signed request bodies.

The record can store a compact bounded summary of repeated identical attempts, but it must never
forget whether any earlier attempt is unresolved. Evidence union must be monotonic and keyed by
exact output identity; repeated responses do not create repeated proofs or history entries.

### 9.2 Output evidence and spendability

Classify each evidence acquisition as complete, partial, valid empty, or unavailable/invalid.
Validate requested-output membership, duplicates, count correspondence, keyset, amount, unit,
operation attribution, and available cryptographic evidence through the appropriate SDK seam.
Missing keysets, malformed signatures, and invalid correspondence must not become a valid empty
Restore. An `UNSPENT` state lookup by itself does not demonstrate prior issuance.

Preserve signed-output evidence independently of `UNSPENT`, `PENDING`, or `SPENT` state. An issued
proof later spent still establishes issuance and must not be credited again. Recovered proofs with
unknown/pending spendability stay unavailable for spending; the implementation needs a durable
quarantine representation or equivalent internal holding area until proof-state reconciliation
settles them. Do not coerce them into the ready balance to fit an existing proof-state enum.

Finalization requires complete validated issuance evidence. It need not wait for a proof-state
lookup to become available, provided every corresponding asset is durably recorded either with a
known state or in that non-spendable holding area. The same commit must establish that accounting
and history cannot later credit the evidence twice. Fresh direct issuance responses may follow the
normal SDK-validated ready-proof path; uncertain/restored evidence requires the state distinction.

Do not repurpose ProofService's existing unspent-only recovery return value as the evidence
interface. Add a narrow evidence acquisition seam; preserve its old consumer behavior until those
consumers deliberately migrate.

## 10. Reconciliation algorithm

Each pass operates on a durable snapshot, obtains at most the required new evidence, commits its
result, and yields. Use existing recovery scheduling/backoff; an unavailable mint must not cause
an unbounded synchronous loop.

1. Load the operation, persisted request, attempt history, and exact locally retained issuance
   evidence. A terminal operation is idempotent; a `pending` operation with proven no submission
   follows authorization rather than pretending it needs response recovery.
2. If local evidence is complete, apply completion without requiring another quote request. Otherwise
   obtain Restore evidence for the exact missing outputs when the capability is available.
3. Merge validated output evidence. Complete coverage permits completion; positive partial coverage
   remains `executing` with a shortfall diagnostic. Do not generate replacement outputs or replay a
   reduced subset as if it were the original operation.
4. When further decisions require quote data, validate the response and record/resolve it through
   canonical Quote Observation before advancement under ADR-0004. Use the accepted quote, not simply
   the last HTTP response. Recompute local facts from the owning transaction when applying a decision.
5. Decide exact replay, waiting, or definitive non-issuance using both the accumulated evidence and
   prior attempts. Preserve the entire original request and reservation while any attempt is ambiguous.
6. Validate a replay's response through the same evidence interface. Already-signed responses can
   trigger another bounded Restore pass. A failed network request is never ordinary completion.

| Situation                                                         | Decision                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Complete exact evidence; quote unavailable or balance now zero    | Complete issuance; reconcile proof spendability separately                                                        |
| Some exact outputs signed                                         | Retain evidence and full unresolved commitment; diagnostic; no ordinary success or replacement request            |
| Valid empty Restore; accepted quote funds the request             | Exact replay may proceed under the supported mint/SDK retry contract                                              |
| Valid empty Restore; accepted quote cannot fund the request       | Wait if any earlier submission is ambiguous; do not infer cancellation                                            |
| Restore unsupported/failed/malformed                              | Preserve ambiguity; bounded observation or a supported exact replay path                                          |
| NUT-19 supported; persisted exact request; quote balance depleted | Cached exact replay may recover success; a miss executes normally and must still be safe under the retry contract |
| Definitive rejection and all earlier attempts proven non-issued   | Fail, or return the unchanged intent to payment waiting if the rejection is retryable                             |
| Missing key or changed quote ownership after uncertain submission | Try to retain/recover issuance evidence; halt new signing with a diagnostic; do not erase prior ambiguity         |

A valid empty Restore is an observation, not a cancellation barrier. The earlier request could
still complete later. Neither quote timestamps nor repeated empty responses prove otherwise.
NUT-19 advertisement/TTL does not prove a cache entry exists. The remote adapter must have verified
concurrent duplicate-output behavior for the supported mint implementations before enabling
concurrent exact replay. If that behavior cannot be established, defer replay while processing may
still be in flight and report the limit; no wallet-only algorithm can manufacture exactly-once
semantics absent a sufficient remote contract.

### Error classification

Use structured protocol errors, retaining the original cause. Keep any legacy message classifier
narrowly at the transport compatibility seam; message text alone must not prove success or
permanent non-issuance.

| Signal                                            | Meaning for this operation                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `20002` quote already issued                      | Obtain exact output evidence; quote accounting alone cannot finalize                                             |
| `11003` outputs already signed                    | Restore the exact outputs; do not assume all outputs were signed                                                 |
| `11004` outputs pending / `20005` quote pending   | Retain reservation and recover later                                                                             |
| `20001` not paid / `20007` quote expired          | May conclusively reject this transmission; must not erase an earlier unresolved transmission                     |
| `20008` invalid signature                         | Conclusive validation rejection may permit a persisted compatibility variant if all earlier attempts are settled |
| Transport/server failure or malformed success     | Ambiguous once submission may have occurred                                                                      |
| Preflight failure before authorization/submission | No remote effect from that preflight; preserve the prepared intent or report the input error                     |

Do not introduce a payment-method-specific `initialAlreadyIssued: return | throw` policy in the
replacement. All three methods feed this common classification.

## 11. cashu-ts integration

The installed version, 5.0.0-rc.4, already shares `prepareMint` and `completeMint` across methods.
Reuse supported SDK preparation/completion and signature validation. Do not copy the cryptography,
wire normalization, or a second set of method dispatch algorithms into Coco.

The current full-quote issuance path also performs local expiry and fresh-balance checks. A
no-network probe confirmed that both BOLT12 and on-chain calls reject an expired funded quote and
a stale insufficient quote snapshot before submission. Existing mocked handler tests do not
establish otherwise. Resolving this integration is a prerequisite for delivering this design.

Requirements for the selected SDK seam:

- Coco can prepare or encode an authorized request against validated canonical facts without an
  advisory local expiry check preventing funded issuance.
- Once saved, completion/replay submits the exact persisted request without regenerating outputs,
  reselecting an active keyset, resizing amounts, or rerunning fresh quote balance admission.
- Historical keysets remain usable to validate/unblind old signatures after deactivation; an inactive
  keyset rejection of new issuance does not erase a prior ambiguous outcome.
- NUT-20 signature compatibility fallback is explicit. Persist a chosen variant before transmission;
  do not allow an SDK helper to silently send a second payload that Coco did not record.
- Current and legacy normalized responses, request encodings, and response validation are tested
  against the actual installed version.

An upstream SDK change may be needed if the public seam cannot meet these requirements. Pin and
verify the compatible version before wiring the new behavior. Do not fake `expiry`, zero out
accounting, or cast incomplete quote objects into full response types to bypass validation.
The exact SDK version/API is a delivery dependency, not assumed to be solved by #480.

## 12. Public behavior, history, and diagnostics

Preserve existing operation IDs, quote references, method names, creation payloads, and public
operation entry points. `MintOpsApi.prepare({ quote, amount })` keeps its required explicit amount;
claim-all selection belongs to existing quote-level automatic processing. Do not silently make
`amount` optional or reinterpret it as an upper bound.

`execute`, `refresh`, recovery, and `finalize` all converge on the common rules. A call can continue
to throw its original transient execution error while the persisted operation remains `executing`;
callers inspect `get`/`refresh` for durable state. Do not invent a successful result to make an API
return terminal. Update comments that currently equate finalized with the quote's terminal state.

Keep event names and the existing history entry per Mint Operation. A finalized event describes
proven issuance, including issuance whose proofs were subsequently spent. Its operation amount is
not a promise of a fresh increase in spendable balance. Unresolved shortfalls/errors are visible
through existing operation diagnostics and additive structured fields as needed, without exposing
recovery payloads. `listInFlight` includes ambiguous operations; document that they now remain
`executing` instead of returning to `pending`.

A quote-wide issued total must not finalize an unrelated pending operation or synthesize new
remote accounting. Remove the BOLT11 finalization path that fabricates an `ISSUED` Quote Observation.
Local completion contributes local issuance facts; only genuine remote observations update
remote-owned totals. [ADR-0004][adr04], [ADR-0010][adr10]

## 13. Persistence migration and compatibility

This replacement requires a storage migration; #480's no-migration constraint does not apply.
Implement a versioned internal recovery repository/store and transaction-scope access consistently
in memory, shared SQL storage, IndexedDB, and the SQLite runtime bindings. Add the evidence holding
area and durable concurrency fields as part of the same supported schema version. Extend storage
conformance coverage before exposing the new runtime path.

Migration rules:

| Existing record                                            | Treatment                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `init` without output data                                 | Preserve/recover intent under the current cleanup policy; never rewind consumed counters                           |
| New-format `pending` with durable no-submission provenance | Safe to authorize its immutable output plan when funded                                                            |
| Legacy `pending` with output data                          | Submission history is unknown: old recovery could return submitted work to pending                                 |
| Legacy `executing`                                         | Treat as potentially submitted; Restore using saved outputs before considering replay                              |
| Legacy `finalized`                                         | Preserve history and conservative local issuance totals; do not silently reopen or re-credit                       |
| Legacy `failed`                                            | Preserve history; targeted recovery of previously misclassified records requires a separate explicit repair policy |

For legacy pending/executing records, preserve original output secrets, amounts, quote identity,
and keysets. Create recovery provenance stating that the exact original transport payload may be
unknown. Do not claim that a newly regenerated signature reproduces the original NUT-19 cache key.
A newly recorded replay variant can use the existing output identity under the supported duplicate
request contract, but must remain distinguished from a known byte-identical replay.

Before enabling new automatic claims for a quote, account for all its legacy potentially submitted
operations as unresolved commitments. Migrate that quote's relevant sibling set atomically, or use
a startup migration that establishes equivalent coverage before writes resume. Do not lazily migrate
only the current operation while ignoring its siblings. Prefer diagnostics and conservative waiting
over releasing an unknown legacy commitment. This may require operator attention on old ambiguous
records; the migration cannot reconstruct missing submission history.

Existing finalized operations may lack complete receipts because old versions accepted
`ALREADY_ISSUED` without proofs. Retain their historical local accounting conservatively, label their
evidence provenance internally, and do not assert that they satisfy the new completion invariant.
The stronger invariant applies to newly settled operations, not retroactively fabricated evidence.

Forward migration must preserve data and be restart-safe. Older binaries cannot safely participate
as concurrent writers after adopting the new reservation/evidence semantics: they do not honor the
new commitments and may overwrite metadata. Define and enforce the supported upgrade/downgrade
policy; a storage reader that cannot enforce the new writer version must not be advertised as
mixed-version safe. No reset, destructive migration, or counter reuse is an acceptable fallback.

## 14. Code and document change map

| Area                                                                                        | Planned changes                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/core/models/MintQuoteClaimability.ts`                                             | Replace BOLT11 atomic-only rule with common accounting; separate selection from outcome                      |
| `packages/core/models/MintQuote.ts` and observation factory                                 | Keep invoice/offer metadata and compatibility projections; remove their role as claim-amount authority       |
| `packages/core/quotes/MintQuoteObservation.ts` and `QuoteLifecycle`                         | Reuse canonical resolution; audit pending quote filters/imports for partial BOLT11 balances                  |
| `packages/core/operations/mint/`                                                            | Common reconciliation, durable request/evidence models, revised state semantics and coordinator dependencies |
| `packages/core/infra/handlers/mint/`                                                        | Typed method adapters/facades; delete duplicated lifecycle policies and reusable-only extraction             |
| Mint remote/SDK seam                                                                        | Versioned request preparation/completion, raw Restore evidence and response validation                       |
| `packages/core/transactions/`                                                               | Mint-owned gateways and same-scope operation/proof/output/evidence commands                                  |
| `packages/core/repositories/`, `packages/sql-storage`, `packages/indexeddb`                 | Recovery storage, conditional writes, migration and transaction-scope participation                          |
| `packages/sqlite3`, `packages/sqlite-bun`, `packages/expo-sqlite`, `packages/adapter-tests` | Bindings, conformance, rollback, concurrency and upgrade fixtures                                            |
| Core APIs/events/history and affected React/cocod consumers                                 | Preserve entry points; update interpretation of pending/executing/finalized and diagnostics                  |
| `packages/core/CONTEXT.md`                                                                  | Common claimability wording, reservation semantics and accepted issuance-evidence term                       |
| ADRs and `TRANSACTION_DESIGN.md`                                                            | Record the accepted Mint outcome decision and maintained Mint transaction contract in implementation PRs     |
| `packages/docs` and changesets                                                              | Explain compatibility, recovery, diagnostics, and actual release impact                                      |

ADR-0007's normalization ownership and ADR-0008's expiry policy remain in force. ADR-0010 has explicit
batch-specific partial-evidence and empty-Restore failure rules; this draft does not override them.
Any future use of the shared module for Batch Mint requires revisiting those rules explicitly.

## 15. Test plan and acceptance criteria

Tests cross the same interfaces as production. Share the scenario matrix across all three methods;
keep method-specific creation tests. Assertions target durable behavior, exact requests, and proof
attribution rather than private helper calls or class inheritance.

### Accounting and compatibility

- Legacy BOLT11 `UNPAID`, `PAID`, and `ISSUED` responses normalize to expected 0/full accounting;
  a full-only mint fixture receives one full-amount request in the normal flow.
- Modern BOLT11 100 paid / 40 issued is valid; automatic selection requests at most the remaining
  locally available 60. No invoice-amount equality guard rejects it.
- Explicit partial requests to a full-only mint are rejected without enlarging/replacing the request
  or reporting success. No capability is inferred from the new accounting fields.
- BOLT12 amountless/fixed offers and on-chain deposit accounting preserve creation and key checks.
- Invalid accounting, older timestamps, conflicting same-timestamp observations, and legacy
  projections cannot corrupt canonical facts. Fresh HTTP arrival does not outrank remote ordering.
- Local completed issuance and reservations prevent duplicate allocation; reconciliation does not
  double-count partial evidence as both settled value and a full reservation.
- Expired on-chain quotes whose earlier deposits confirm remain claimable; zero balance is not
  proof of an operation outcome or permanent closure of a reusable quote.

### Request, SDK, and outcome evidence

- Actual SDK methods, with remote HTTP mocked at the transport boundary, exercise expiry, balance,
  signature-version fallback, historical keysets, and response validation. Mocked Wallet methods
  alone do not satisfy this acceptance criterion.
- Restart replays the persisted payload, ordered outputs, amounts and selected signature variant.
  Different serialization versions cannot silently regenerate it.
- Complete, partial, empty, failed, unsupported, duplicated, mismatched, and malformed Restore
  responses produce distinct decisions. Missing keysets are not empty issuance evidence.
- Already-spent and pending restored proofs remain evidence of issuance without entering ready
  balance. Unknown proof state is durably quarantined and later reconciled without duplicate credit.
- Quote-level `20002`, output-level `11003`, pending codes, and expired/invalid-signature errors
  produce the same rules for all methods. A message containing “expired” is not a terminal proof.
- Another operation or wallet consuming a quote does not finalize this operation's unrelated outputs.
- A persisted 100-sat request remains unchanged after a 60-sat observation. A separate automatic
  claim, if permitted, has another ID, output plan, and history entry.
- Cache hit restores the previous result; cache miss executes normally. Neither optional capability
  support nor TTL is treated as a cancellation or exactly-once guarantee.

### Crashes, concurrency, and migration

- Inject failure before/after output allocation, authorization, transmission marking, response
  arrival, evidence persistence, and finalization. Rollback preserves every required invariant.
- Two independent coordinators using the same storage cannot reserve the same available value.
  Recovery ownership and stale-worker results cannot replace request identity or settled outcomes.
- A request finishing after an empty Restore or worker lease expiry cannot lead to a second claim
  against its unresolved reservation.
- Proof/evidence storage and operation finalization commit atomically on every adapter. Event
  listener failures do not replay issuance or roll back committed outcomes.
- Legacy pending/executing fixtures retain unknown submission provenance and all sibling commitments.
  Existing finalized/failed history is preserved, including records lacking complete receipts.
- Retry/update serialization and upgrade interruption preserve exact output data and counters;
  unsupported mixed-version writing is rejected or explicitly prevented by the deployment contract.

Acceptance also requires removal of the old built-in recovery decisions, no added architecture
exceptions, reviewed public/plugin exports, documented diagnostics, and changesets for each affected
published package. Do not claim success by passing only the pre-refactor characterization tests.

### Verification commands

At implementation time, use package scripts as the source of truth. The current baseline is:

```sh
bun install --frozen-lockfile
bun run --filter='@cashu/coco-core' test:unit
bun run build
bun run typecheck
bun run --filter='@cashu/coco-indexeddb' test
CI=1 bun run --filter='@cashu/coco-indexeddb' test:browser
bun run --filter='@cashu/coco-sqlite' test
bun run --filter='@cashu/coco-sqlite-bun' test
bun --cwd packages/expo-sqlite test
```

Run narrower scenario files first, then full relevant suites and new shared adapter conformance.
Run commands sequentially where prerequisites rebuild shared `dist` output; concurrent rebuilding
and typechecking can produce misleading missing-export failures. Add the real-SDK and supported-mint
integration checks to the relevant package scripts/CI; use controlled local fixtures, not real funds.
Clearly report unavailable runtime/browser environments instead of substituting mocked conformance.

## 16. Delivery sequence and PR replacement

1. **Review this replacement scope.** Record the intentional behavior changes, SDK dependency, and
   storage/compatibility contract in the implementation issue. Mark #480 superseded when this plan
   is adopted. Its current GitHub state is independent of this draft's status.
2. **Establish compatibility tests and SDK feasibility.** Exercise legacy/full-only BOLT11 and the
   real installed SDK. Select or obtain a supported exact-request seam; verify mint concurrency
   assumptions. This phase must resolve the SDK gap before claiming the target behavior works.
3. **Introduce common accounting and selection rules.** Add pure rules and compatibility fixtures,
   retaining exact operation amounts. They can land before runtime wiring. Do not enable new automatic
   remainder claims against legacy unresolved operations until the migration/reservation coverage in
   the next phase is active; update the glossary and discovery/public guards with the behavior switch.
4. **Add durable request/evidence storage and Mint transaction ownership.** Implement migrations,
   quarantine/receipt representation, revisions, sibling reservation reads, rollback and conformance.
   Do not enable the new ambiguous-submission policy until all these writes are crash-safe.
5. **Wire the common reconciliation path for all three methods.** Migrate legacy provenance, update
   event/history semantics, and remove old method outcome branches and the reusable-only module.
6. **Complete regression, migration, and release review.** Document remaining remote-protocol limits,
   release notes, and the supported storage writer version. Monitor shortfalls and unresolved legacy
   operations without logging recovery material.

Prefer small reviewable PRs against `master` once their actual prerequisites are merged. Do not
inherit unrelated commits just because #480's worktree was based on #461. The transaction slice
requires the accepted transaction baseline (currently represented by #461) or its merged equivalent;
it does not require the unrelated Send/Receive implementation branches. If a dependency is still
unmerged, make any temporary stack explicit in the PR body and retarget after merge.

This draft and its research note have no runtime effect and need no published-package changeset.
The implementation does: storage and semantic changes require a fresh per-package assessment.
Normal API entry points can remain stable, but an incompatible repository/adapter contract may
require a breaking release or an explicit compatibility bridge. Do not carry #480's patch-only
release assumption into this larger design without that review.

## 17. Decisions fixed here and implementation gates

Fixed by this proposal:

- one standalone reconciliation algorithm for all three methods;
- standard accounting, including partial BOLT11 observations, with automatic claim-all selection;
- immutable operation amounts/outputs and persisted request variants;
- completion based on full issuance evidence, separate from current spendability;
- preservation of ambiguous reservations and local history;
- method-specific creation/signing, SDK-owned wire normalization, and Mint-owned transactions;
- no changes to Batch Mint policy through this refactor.

The implementation must settle these gates with concrete evidence, not optimistic assumptions:

| Gate                                             | Required resolution                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| SDK expiry/admission and exact replay seam       | Supported version/API plus real-SDK tests; no fabricated quote workaround                        |
| Signature compatibility fallback                 | Durable variant handling or a supported SDK mechanism exposing each transmission                 |
| Remote duplicate request concurrency             | Documented/tested supported-mint behavior and conservative fallback when unknown                 |
| Evidence/quarantine representation               | Versioned lossless schema; no duplicate balance credit; historical keyset support                |
| Storage upgrade/writer compatibility             | Adapter conformance, restart-safe migration, legacy sibling coverage, enforced deployment policy |
| Public/repository compatibility and release type | Export/API audit and explicit package versioning decision                                        |

These gates do not weaken the target invariants. If one cannot be met, the affected behavior stays
conservative and the limitation is reported; it is not replaced by method-specific success rules.

[nut04]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/04.md
[nut07]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/07.md
[nut09]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/09.md
[nut19]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/19.md
[nut23]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/23.md
[nut25]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/25.md
[nut30]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/30.md
[errors]: https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/error_codes.md
[adr04]: ../../packages/core/docs/adr/0004-quote-observations-precede-operation-advancement.md
[adr10]: ../../packages/core/docs/adr/0010-persist-exact-batch-issuance-before-submission.md
[adr11]: ../../packages/core/docs/adr/0011-use-domain-transaction-gateways.md

## 18. Implementation choices

The implementation is based directly on `master` and the strong repository transactions merged in
PR #460. It introduces the Mint-owned runner/gateway/scoped commands without importing the separate
keyring migration from PR #461. The maintained contract is [TRANSACTION_DESIGN.md](../../TRANSACTION_DESIGN.md).

- The installed cashu-ts 5.0.0-rc.4 public `prepareMint` quote-reference input accepts real quote
  identity and ownership without expiry/accounting metadata. Coco performs canonical admission in
  its transaction. `completeMint` submits the persisted preview without a fresh admission check.
  No expiry or balance fields are falsified, and no SDK private methods are called.
- Coco stores both current and legacy signatures and records the rejected current request when
  selecting the legacy variant. SDK automatic signature fallback is disabled by omitting
  `legacySignature` from completion. Negative transitions require the matching authorization revision.
- There is no verified supported-mint duplicate-request concurrency contract in this change.
  Therefore ambiguous recovery uses saved evidence and Restore and **does not automatically replay**.
  This includes a crash after authorization but before transmission. Such an operation can remain
  unresolved indefinitely. The design's conservative fallback is active; optional NUT-19 support
  alone is not treated as evidence that replay is safe.
- Recovery sidecars store validated, unblinded per-output receipts with lossless amounts. Partial,
  unknown-state, and pending-state receipts remain outside spendable proof storage. Startup recovery
  revisits held proofs even after issuance has finalized. Existing proofs are never overwritten over
  later spending ownership or re-credited.
- SQL migration 039 and IndexedDB version 34 add the sidecar. Whole-sibling provenance migration is
  atomic and idempotent at admission. Queries also count missing legacy provenance conservatively
  before migration. Historical terminal records retain their state without fabricated evidence.
- IndexedDB rejects old schema opens. SQL cannot retroactively fence an old binary; applications
  must enforce an exclusive upgrade and stop all older writers. Mixed-version writing and downgrade
  after adoption are unsupported. Core and public adapters receive major changesets for the new
  required repository contract; application operation entry points remain available.

The real-SDK test suite uses controlled transport fixtures with deterministic signed outputs. The
adapter suites verify persistence and transaction rollback. These tests do not establish arbitrary
mint-server concurrency behavior, hence the explicit no-replay fallback above.
