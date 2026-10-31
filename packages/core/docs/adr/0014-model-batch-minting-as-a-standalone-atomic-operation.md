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
Automatic claiming is the main consumer and may afterwards claim still-claimable members
individually. Members keep per-quote mint history entries so batching does not change what a
Wallet's history shows. This supersedes the retired ADR-0009 and ADR-0010.
