---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Harden Send preparation, execution, completion, cancellation, reclaim, and Operation Recovery so
proof ownership, deterministic output allocation, and operation state commit atomically. Keep mint
requests outside storage transactions and retain exact requests and reservations after ambiguous
outcomes or replay rejections.

- Preserve the committed input order during swap submission and replay so retries can retrieve
  cached mint responses after an interrupted request.
- Recover legacy executing and pending Sends without duplicating proofs, resetting spent change,
  or releasing another operation's reservations. Mark recovered ready send outputs inflight
  atomically with their pending token. Finalize eligible legacy pending P2PK Sends without
  fabricating missing proofs or tokens.
- Persist reclaim output plans separately from the original Send request. Use the persisted output
  keyset to unblind swaps and reclaim results, rejecting empty or mixed-keyset output plans before
  contacting the mint.
- Publish events after commit, with pending Send notifications before proof watchers can finalize
  the operation. Emit release events only for reservations actually released.

Existing persisted Send requests remain compatible. Interrupted reclaim continues to require
manual seed Restore.

### Breaking change for custom storage adapters

Custom `SendOperationRepository` implementations must implement `transition(input)`. Within the
caller's repository transaction, atomically compare the persisted operation's state and revision
with `expectedState` and `expectedRevision`, treating missing legacy revisions as zero. On a match,
persist `next` with revision `expectedRevision + 1`; otherwise return `false` without writing. The
transition must share the caller's transaction so proof writes roll back when the transition fails.
Bundled adapters implement this contract.
