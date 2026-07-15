# PROTOTYPE - Mint Issuance Attempt Persistence

Question: what durable record, repository surface, adapter schema, and transaction boundary let a
Mint Issuance Attempt atomically reserve member Mint Operations, allocate deterministic counters,
persist coalesced output data, survive restart, and later attribute proofs without making Mint Batch
a public operation?

This is a throwaway logic prototype. It uses an in-memory transactional store to make the proposed
boundary visible before implementation work starts.

Run from the repository root:

```sh
bun run --filter='@cashu/coco-core' prototype:mint-attempt-persistence
```

Useful paths through the TUI:

- create an attempt, then crash before remote I/O: the persisted attempt remains recoverable.
- create and then finalize: proof provenance and member finalization commit together.
- create and then reject: members return to pending while the rejected attempt remains historical.
- reset, then try to finalize or reject before reserving: the illegal transition is refused.

