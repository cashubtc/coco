---
status: accepted
---

# Never lower or reclaim allocated counter and key positions

An Output Allocation commits its counter positions together with the output plan that consumes
them, and a Keypair Allocation commits its derivation index together with the keypair. A committed
position is never used again. Cancelling, failing or deleting the operation leaves its positions
consumed, deleting a keypair does not free its index, and Restore advances an Output Counter to at
least the position after the last restored signature but never lowers it. A derivation inside a
transaction that does not commit is not an allocation and may be repeated.

A request that timed out may still have reached the mint, so the mint may hold or have signed a
blinded message for a position the Wallet considers unused. Deriving the same secret or key for a
second purpose could then be rejected as already signed, or collide with proofs a later Restore
finds.

## Considered Options

- **Reclaim the positions of an operation cancelled before submission.** Rejected because it
  requires proof that no request carrying those outputs ever reached a mint, and lowering a counter
  would hand out positions that later allocations already took.

## Consequences

Counters have gaps: positions that were committed but never produced a proof. An Output Counter is
therefore not a count of issued proofs, and comparing the two does not establish completeness.
