# Mint Quote reconciliation: specification research

Research date: 2026-09-05. Upstream Cashu NUTs were read at commit
[`49a909ce4d0739824b3859d4b3da21e6c1abdaeb`](https://github.com/cashubtc/nuts/tree/49a909ce4d0739824b3859d4b3da21e6c1abdaeb).
This is a design investigation, not an accepted change to Coco's domain contract.
Normative requirements below describe the current specifications, not every deployed mint.
The resulting [replacement refactor design](../design/mint-reconciliation.md) supersedes the
provisional implementation recommendation below and the narrower approach in PR #480.

## Shared accounting, including BOLT11

NUT-04 applies to all three methods. Every Mint Quote response must contain nonnegative
`amount_paid`, `amount_issued`, and `updated_at`; issued value cannot exceed paid value.
The remote mintable balance is `amount_paid - amount_issued`. A request cannot exceed that
balance; issuing a smaller amount increases `amount_issued` only by that amount.
The timestamp must increase when accounting changes, including changes within one timestamp
resolution. Wallets must reject older observations and must not regress accounting from stale
responses. A fresh HTTP response is therefore not necessarily the newest Quote Observation.
Method settings can impose operation amount limits.
[NUT-04](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/04.md#common-request-and-response-formats)

**Inference:** aggregate issued value answers how much the mint issued, not which Exact Operation
Request received signatures. Two operations can claim the same quote; an accounting increase does
not identify either operation's outputs. Balance controls admission to issuance, while exact output
evidence establishes its outcome.
[NUT-04](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/04.md#executing-a-mint-quote)

## Differences in payment and authentication

| Method   | Payment request                                | Quote creation amount | Quote authentication       |
| -------- | ---------------------------------------------- | --------------------- | -------------------------- |
| BOLT11   | Lightning invoice                              | Required              | NUT-20 locking is optional |
| BOLT12   | Lightning offer; can receive repeated payments | Optional/null         | Public key required        |
| On-chain | Bitcoin address; can receive multiple deposits | No amount field       | Public key required        |

These distinctions concern how value reaches the quote and who may claim it.
[NUT-23](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/23.md#mint-quote),
[NUT-25](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/25.md#mint-quote),
[NUT-30](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/30.md#mint-quote),
[NUT-20](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/20.md#mint-quote)

For BOLT11, `state` is deprecated and optional; wallets should prefer accounting when present.
Its expiry is the invoice payment deadline. NUT-23 adds no rule requiring all paid value to be
issued in one request. Read with NUT-04, a fixed invoice amount does not establish a fixed
issuance amount. Coco's present all-or-nothing BOLT11 policy is an implementation restriction,
not a general statement of current Cashu minting semantics.
[NUT-23](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/23.md#mint-quote),
[Coco glossary](../../packages/core/CONTEXT.md)

BOLT12 explicitly permits partial claims and requires mints to accept claims within available
balance. An offer's creation amount does not constrain each later issuance to that amount.
Unlike on-chain, its specification describes expiry generically as quote validity and does not
define the same detailed treatment of payments detected around expiry.
[NUT-25](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/25.md#multiple-issuances)

On-chain `amount_paid` includes eligible confirmed UTXOs. Each UTXO must independently meet the
minimum deposit amount; several undersized UTXOs cannot be combined to qualify. Mints must keep
monitoring transactions detected before expiry until confirmation, eviction, or replacement.
Payments first detected after expiry cannot increase accounting. Thus accounting can increase
after expiry as an earlier payment confirms. Wallets should not send after expiry. Partial
claims are explicitly allowed; mint settings should describe confirmation depth.
[NUT-30](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/30.md#minting-tokens)

NUT-20 authenticates the quote ID and ordered outputs, including their amounts and blinded
messages. It recommends a new locking key per quote; this is a SHOULD, whereas BOLT12 and
on-chain require a public key. This authentication is not an operation receipt. A valid
signature on another request for the same quote does not identify the first request's outcome.
[NUT-20](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/20.md#signing-the-mint-request)

## Restore evidence and spendability are separate

NUT-09 is optional. A supporting mint stores each issued blinded signature with its blinded
message. Restore returns signatures for previously signed messages, with equally sized output
and signature arrays paired by index. It does not return a Quote Observation or require that
the returned list have the same size as the requested list.
[NUT-09](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/09.md)

**Inference:** validate correspondence with the persisted output set, including amounts and
keyset IDs. Distinguish complete coverage, partial coverage, a valid empty response, and an
unavailable/invalid response. A positive subset is evidence of those signatures, not of full
completion. A Restore error is not an empty result. NUT-09 does not specify a cross-endpoint
snapshot, cancellation of an earlier request, or a guarantee that an in-flight mint request
cannot finish after an empty Restore. It therefore does not alone prove permanent non-issuance.
[NUT-09](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/09.md)

NUT-07 checks whether a proof is unspent, pending in a transaction, or spent. This is a different
question from whether it was issued. **Inference:** filtering Restore results to spendable
proofs loses evidence needed for Operation Recovery. An issued proof that was later spent still
demonstrates issuance; it must not be credited as newly spendable value.
[NUT-07](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/07.md#token-states)

## Exact replay and cache limits

NUT-19 is an optional successful-response cache. Its lookup key depends on method, path, and
payload. On a hit, the mint returns the earlier success; on a miss, it processes the request
normally. Support is advertised for specific endpoints, with an advertised TTL; null means
indefinite caching is expected.

**Inference:** preserve the complete submitted payload, including output order and authentication,
to enable cached replay. Regenerating a signature can change the payload even if it authorizes
equivalent outputs. Cache support and an unelapsed TTL do not prove that a response was cached.
The specification does not supply durable exactly-once processing, synchronization between two
cache misses, or atomic commitment of cache entries with issuance. Cached replay can improve
recovery, but it does not replace output evidence or resolve every ambiguous outcome.
[NUT-19](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/19.md)

## Error scope matters

| Code    | Protocol meaning               | Reconciliation implication (inference)                                                             |
| ------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `11003` | Outputs already signed         | Recover the exact outputs; this is not a complete proof set                                        |
| `11004` | Outputs pending                | Retain ambiguity while processing can finish                                                       |
| `20001` | Quote request not paid         | Does not prove a prior request never issued                                                        |
| `20002` | Quote already issued           | Quote-level evidence does not identify this operation's outputs                                    |
| `20005` | Quote pending                  | A retry must account for concurrent processing                                                     |
| `20007` | Quote expired                  | Remote rejection differs from elapsed local time; it does not itself resolve a prior lost response |
| `20008` | Invalid mint request signature | Correctable request rejection; consider any earlier unresolved submission separately               |

These codes describe errors, not a comprehensive precedence or concurrency contract. A message
containing “expired” is weaker than a structured protocol error. Do not treat every error as
either success or definitive non-issuance of all previous attempts.
[NUT error codes](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/error_codes.md)

## Batch atomicity and remaining specification gaps

NUT-29 explicitly defines an atomic batch and rejection without issuing any member when validation
fails. Its batch-specific validation still mentions BOLT11 state and method-dependent amount
rules. Do not infer that every standalone mint endpoint has the same detailed atomicity and
reconciliation contract, or use the batch rules to override NUT-23's standalone interface.
[NUT-29](https://github.com/cashubtc/nuts/blob/49a909ce4d0739824b3859d4b3da21e6c1abdaeb/29.md#request-validation)

The specifications leave practical questions to implementation or further clarification:
the visibility of an in-flight request to Restore; ordering across Restore, quote checks, and
replay; and whether an error after an earlier timeout can establish permanent non-issuance.
Any stronger recovery guarantee needs evidence from the supported mint implementations or an
explicit protocol contract, not an assumption that successive HTTP responses form one snapshot.

## Coco contract considerations

Changing BOLT11 issuance policy requires revisiting the all-or-nothing wording in the
[Coco glossary](../../packages/core/CONTEXT.md). Existing normalization belongs to cashu-ts under
[ADR-0007](../../packages/core/docs/adr/0007-cashu-ts-owns-wire-quote-normalization.md).
[ADR-0004](../../packages/core/docs/adr/0004-quote-observations-precede-operation-advancement.md)
requires recording Quote Observations before operation advancement, and
[ADR-0008](../../packages/core/docs/adr/0008-treat-mint-quote-expiry-as-advisory.md)
treats Mint Quote expiry as advisory.

[ADR-0010](../../packages/core/docs/adr/0010-persist-exact-batch-issuance-before-submission.md)
contains specific batch policies for partial Restore and empty Restore with unclaimable members.
These policies must not silently become universal standalone policies; a different shared rule
needs explicit ADR review. Any persistence redesign must preserve the authority and remote-I/O
boundaries in [Transaction Design](../../TRANSACTION_DESIGN.md) and
[ADR-0011](../../packages/core/docs/adr/0011-use-domain-transaction-gateways.md).

## Findings in the current Coco implementation

Source inspection at Coco commit `6b9c82be850229af0202741e60f741e0c466f21c`:

- [Claimability](../../packages/core/models/MintQuoteClaimability.ts) rejects partial BOLT11
  accounting and claim amounts different from the invoice amount. Payment request reuse and
  partial issuance are therefore coupled in the present model.
- [Reusable recovery](https://github.com/cashubtc/coco/blob/6b9c82be850229af0202741e60f741e0c466f21c/packages/core/infra/handlers/mint/ReusableMintLifecycle.ts) starts
  with Restore, while [BOLT11 recovery](../../packages/core/infra/handlers/mint/MintBolt11Handler.ts)
  checks the quote first and can replay before Restore. This ordering difference is not required
  by the payment methods' quote shapes.
- [ProofService](../../packages/core/services/ProofService.ts)'s
  `recoverProofsFromOutputData` returns only `UNSPENT` proofs. An empty array can mean no signatures,
  all recovered proofs already spent/pending, or signatures skipped because keysets were missing.
  This interface discards distinctions needed for issuance reconciliation.
- [MintOperationService](../../packages/core/operations/mint/MintOperationService.ts) normally
  checks that every saved output secret exists before finalizing. Its initial `ALREADY_ISSUED`
  branch can instead finalize with an error and no proofs. BOLT11 and BOLT12 produce that result;
  on-chain throws into recovery. These are existing implementation differences, not distinct
  protocol completion rules. The complete-output check also merits validation of amount,
  keyset, unit, and operation attribution, rather than only secret presence.
- The same module counts only `executing` operations as reservations. Returning an ambiguous
  submitted operation to `pending` releases its reservation even though the earlier remote
  request may still take effect. This is a design concern from source inspection, not a reproduced
  double issuance.
- [Quote Observation resolution](../../packages/core/quotes/MintQuoteObservation.ts) already
  owns monotonic accounting and timestamp handling. Recovery should consume accepted canonical
  observations through that seam instead of independently interpreting raw HTTP snapshots.

### Installed SDK behavior and verification gap

Coco pins `@cashu/cashu-ts` 5.0.0-rc.4. Its installed `lib/cashu-ts.es.js` routes all three
`mintProofs*` methods through shared `prepareMint` / `completeMint` logic. The former validates
expiry and observed available balance; the latter submits a prepared payload and validates returned
signature count, keyset IDs, and amounts. Thus transport-level issuance is already substantially
shared below Coco. The installed migration guide documents the general balance check and legacy
quote normalization.

A no-network probe exercised the real BOLT12 and on-chain Wallet methods, stubbing only
`requireSupport` to bypass mint-info loading and installing a submission trap. With an otherwise
funded quote whose expiry was `1`, both rejected with `Mint quote probe has expired`. With no expiry,
paid value `1`, issued value `0`, and requested value `10`, both rejected with
`Mint quote probe has only 1 available to mint; requested 10`. Both checks happen before submission.
The probe is available for this session at `/tmp/coco-mint-sdk-probe.mjs`.

The handler tests use mocked Wallet issuance methods, so their passing expiry/stale-balance cases
establish Coco handler behavior, not the behavior of that SDK path. This mismatch predates PR #480.
A redesign needs tests crossing the real SDK seam and an explicit resolution of its validation
policy. Do not fabricate remote accounting or move wire normalization into Coco to bypass it.

## Proposed shared standalone reconciliation

This is a recommendation inferred from the specifications and local code, not a protocol mandate
or an implemented change.

Put one reconciliation decision module behind the existing MintOperationService for all three
standalone methods. It consumes the Exact Operation Request, exact-output evidence, accepted
canonical Quote Observations, and local issuance/reservation facts. Keep payment creation,
method-specific response validation, and optional/required quote signing in typed adapters.
The refined recommendation is to accept standard accounting for BOLT11 and automatically claim
all locally available value. Legacy normalized responses still produce the normal full-invoice
claim; modern partial accounting can produce a remainder claim without adding a chunking API.
Existing prepared/submitted operations keep their exact amount and outputs. See the replacement
design for selection, older-mint rejection, and migration rules.

| Evidence for the exact persisted outputs                    | Proposed decision                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Complete validated issued set, locally retained or restored | Record issuance completion; reconcile current proof states separately and credit only spendable proofs                              |
| Partial validated set                                       | Retain evidence and a shortfall diagnostic; do not report ordinary completion or generate replacement outputs                       |
| Valid empty Restore                                         | Assess canonical claimability and prior submissions; consider exact replay, but do not infer cancellation or permanent non-issuance |
| Failed, unsupported, or malformed Restore                   | Retain the ambiguous operation and its reservation; retry observation or use a supported exact replay path                          |
| Already-issued or outputs-pending response                  | Gather output evidence; the response alone is insufficient to finalize or release the reservation                                   |

For retry decisions, preserve the existing distinction between remote issued totals and local
finalized issuance: do not add two observations of the same issuance. Reconcile unresolved
reservations conservatively. Keep a submitted operation `executing` while its outcome is ambiguous;
reserve `pending` for an operation that is waiting for payment without an unresolved submission.
A rejection of a later retry must not erase an earlier timeout's ambiguity.

Persist a transport-ready request before submission, including output order and the selected
signature payload. Use the SDK's supported prepared-request completion seam for exact replay,
with its signature-version compatibility behavior explicitly accounted for. NUT-19 caching can
help recover a lost response even when quote availability is now zero, but every cache miss may
execute normally. The retry policy still needs mint-side duplicate-output/concurrency guarantees;
neither the quote check nor empty Restore supplies a cancellation barrier. Avoid replacing an
uncertain request with newly generated outputs or a resized claim.

Remote I/O stays outside transactions. The owning transaction records validated issuance evidence,
proof states, reservation settlement, and operation completion together, followed by events after
commit under ADR-0011. Keeping evidence of already-spent issuance may require persisted receipt
material; it must not re-add spent proofs to the ready balance. Batch-specific shortfall and failure
policies in ADR-0010 remain separate unless that contract is explicitly revised.

Before changing runtime behavior, cover complete/partial/empty/failed Restore, spent and pending
restored proofs, late completion after a timeout, stale Quote Observations, an issued quote with
unrelated outputs, exact replay/cache hit/cache miss, and real-SDK expiry and balance validation.
These tests should drive the shared rule rather than preserve accidental method-specific outcomes.
