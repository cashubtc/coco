---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': patch
'@cashu/coco-sql-storage': patch
'@cashu/coco-adapter-tests': patch
---

Move standalone Mint mutations behind the shared transaction runner. Deterministic counters and
pending operations commit together; proof settlement, legacy BOLT11 quote accounting, and operation
completion share one transaction. Existing method-specific claimability, replay, already-issued,
and expiry behavior is retained.

The internal MintOperationService constructor now accepts narrow queries, a remote interface, and
MintTransactions. Custom Mint method handlers return preparation metadata and recovery proof
candidates instead of allocating outputs or saving proofs through handler context services.
Manager and the public MintOps API retain their interfaces.

Mint repositories must preserve caller-owned millisecond timestamps on create and update. The
existing timestamp columns remain compatible with old rows; no schema migration or recovery table
is introduced. Core uses conditional state and timestamp checks to ignore stale transition results.

Mint preparation and recovery now use an explicit, independently committed metadata refresh and
read-only snapshots. Reuse the shared metadata gateway, transport, and Output Allocation from the
Send migration; allocation revalidates the persisted keyset's activity, unit, and keys before
committing its counter and operation. Method capability checks share pure snapshot logic with
MintService. Custom MintService construction supplies the metadata action dependencies.
