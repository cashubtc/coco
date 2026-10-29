---
status: accepted
---

# Model batch minting as a standalone atomic operation

Coco represents one NUT-29 issuance as a standalone Batch Mint Operation. It is neither a parent of
Mint Operations nor a transparent re-batching of prepared ones. Each NUT-20 signature covers the
complete output set, so outputs cannot be attributed to members, and replacing a prepared Mint
Operation's outputs would break its exact-request recovery. Admission, Output Allocation, signing
and Mint Quote Reservation commit together as `executing`. Coco submits only that exact persisted
request, never splits it, and never falls back to Mint Operations for it. Automatic claiming is the
main consumer and may afterwards claim still-claimable members individually. Members keep per-quote
mint history entries so batching does not change what a Wallet's history shows. This supersedes the
retired ADR-0009 and ADR-0010.
