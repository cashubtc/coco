---
status: accepted
---

# Persist exact batch issuance before submission

A Batch Mint Operation moves from `init` to `prepared` only after Coco has persisted the complete
ordered NUT-29 request and its aggregate output recovery material. Coco then persists `executing`
before network submission, so recovery can reproduce the exact request without regenerating
outputs, signatures, or other request facts.

Preparation sums all member allocations and creates one denomination-optimized deterministic
output set for that aggregate amount. The resulting proofs belong to the Batch Mint Operation
through `createdByOperationId`; they are not partitioned or attributed back to individual members.

## Considered Options

We rejected preparing request material only in memory because a crash could strand deterministic
outputs or make exact replay impossible. We also rejected rebuilding failed batches from their
members because doing so could change outputs, signatures, or membership after the original request
may have reached the mint.

## Consequences

The lifecycle is `init` to `prepared` to `executing`, followed by `finalized` or a definitively
non-issued `failed` outcome. There is no payment-waiting `pending` state because every member is
claimable at admission. A definitive pre-issuance rejection fails the operation and releases its
reservations; Coco does not split it or fall back to individual Mint Operations. Before submission,
the caller may explicitly abort an `init` or `prepared` operation, which records an aborted failure
and releases all reservations. An `executing` operation cannot be aborted, and prepared operations
do not expire automatically. Aborting never decrements deterministic output counters; unused
positions remain permanently unused so Coco cannot reuse output secrets.

Execution revalidates the persisted operation and local reservations but does not perform a fresh
quote-check HTTP call before sending the exact NUT-29 mint request. Only a valid response that
clearly rejects that exact request proves non-issuance and moves the operation to `failed`. Network
errors, timeouts, server errors, malformed responses, and cryptographically invalid success
responses are ambiguous after submission and leave the operation `executing` for recovery.

Finalization uses the repository transaction seam to save the complete validated proof set and
transition the operation to `finalized` atomically. It does not mutate remote-owned Mint Quote
Accounting or fabricate a Quote Observation. Mint Quote Claimability derives each member's full
requested amount as local finalized issuance and combines it with the observed remote issued amount
using the existing maximum rule rather than adding them. Failed and aborted batches contribute no
finalized amount. The batch module uses transaction-scoped repositories directly and emits proof
and operation events only after commit. The in-memory repository adapter must gain rollback
semantics so this invariant holds for every supported adapter; a failed commit leaves the operation
`executing` with its reservations and recovery material intact.

Operation Recovery first loads locally saved exact proofs and attempts NUT-09 Restore with the
persisted aggregate outputs. Only an incomplete Restore proceeds to batch Quote Observation. When
no exact outputs are known and every member remains claimable after excluding this operation's own
reservations, Coco may replay the exact persisted request; replay never changes membership, amounts,
outputs, or signatures.

Recovery resumes an `init` operation from its exact persisted members and completes preparation
without network submission. It leaves `prepared` operations untouched; only an explicit `execute`
call may submit them. Output positions that might have been allocated before an `init` crash are
not reused.

As a deliberately small protocol-violation exception, a valid partial exact proof set is saved and
the operation becomes `finalized` with a proof-shortfall diagnostic; Coco does not retry issuance or
add another terminal state for a condition NUT-29 prohibits. Its full member allocations still
count as local finalized issuance so Coco cannot claim the same value again. Normal successful
finalization still requires the complete expected proof set.

A successful, valid Restore that finds zero exact outputs can prove non-issuance when fresh Quote
Observations also leave at least one member unclaimable for its allocation. Coco then marks the
atomic batch `failed`, releases all of its reservations, and leaves other still-claimable value for
future operations. An unavailable, failed, or malformed Restore proves nothing and leaves the batch
`executing`.
