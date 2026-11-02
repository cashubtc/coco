---
status: accepted
---

# Model batch minting as a standalone atomic operation

Coco represents one NUT-29 issuance as a standalone Batch Mint Operation. It is neither a parent of
Mint Operations nor a transparent re-batching of prepared ones. A batch owns one
denomination-optimised output set for its combined amount, so a group of quotes produces fewer
proofs than separate splits would. Those outputs cannot be attributed to individual members, and
replacing a prepared Mint Operation's outputs would break its exact-request recovery. Admission,
Output Allocation and Mint Quote Reservation commit together as `executing`. Coco submits only those
exact members, amounts and outputs, signed at submission as a Mint Operation is, never splits them,
and never falls back to Mint Operations for them.
Automatic claiming is the planned main consumer in the next slice (#573), where it may
afterwards claim still-claimable members individually. Members keep per-quote mint history entries so batching does not change what a
Wallet's history shows. This supersedes the retired ADR-0009 and ADR-0010.

## Recovery through exact replay

Operation Recovery first finalizes from a complete set of locally saved proofs. Otherwise it replays
the exact persisted members, amounts and outputs, signing at submission. A complete valid response
finalizes; a transport failure, server error, malformed response or other ambiguous replay outcome
ends the run with the operation still `executing`. There is no timer, internal retry loop or quote
check. Operation age does not establish whether a remote attempt finished.

Only allowlisted issuance-related replay rejections trigger NUT-09 Restore: legacy outputs already
signed (`10002`), current outputs already signed (`11003`), quote already issued (`20002`), and CDK's
duplicate-output mapping (`20006`, whose text is "Invoice already paid or pending"). This classification
is specific to the batch issuance endpoint, not an interpretation of that code for other operations.
Complete valid unspent signatures finalize the batch. An explicitly empty response (both outputs and
signatures empty) permits failure and reservation release, provided no matching proofs are already
saved locally. Partial, malformed, mismatched, unavailable, spent or pending results retain `executing`.
Other replay rejections, including a changed batch-size limit or insufficient reusable quote balance,
remain unresolved: rejecting the replay does not by itself disprove an earlier issuance. A later
Wallet Restore can save the proofs and let the next recovery run finalize locally.

This empty-result rule deliberately assumes that the mint serializes conflicting exact requests,
commits signatures and quote issuance atomically, and exposes those signatures to Restore before
returning a qualifying rejection. CDK's SQL issuance path provides that ordering for a duplicate
request rejected after the competing transaction commits. Restore-first followed by quote checks
could instead observe opposite sides of that commit; replay-first obtains the ordering from the
issuance response. A mint that returns those codes early, or serves stale Restore data, violates the
assumption and can cause a false terminal failure requiring separate Wallet Restore. This is an
accepted interoperability tradeoff, not a general proof from an empty response or error code.

Initial submission keeps its definitive-rejection policy. Recovery never applies that entire
allowlist as evidence against earlier attempts. Settlement, deferral and failure still use the shared
Wallet transaction runner; remote replay and Restore happen outside transactions and events follow
commit. No persistent format or public API changes are needed.
