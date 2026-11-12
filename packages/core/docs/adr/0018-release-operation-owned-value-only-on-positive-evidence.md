---
status: accepted
---

# Release operation-owned value only on positive evidence of non-effect

An operation persists its Exact Operation Request and its authorization before the first remote
submission. Operation Recovery retains that request and, where replay is permitted, reuses it. After
submission, only positive evidence that the mint did not act on the request permits releasing the
operation's proofs, allocations or reservations, or recording failure. Timeouts, transport errors,
malformed responses, crashes, exhausted retries and elapsed time are not evidence: they leave an
Ambiguous Operation Outcome, and the operation stays recoverable with everything it owns.

A lost response looks the same as a lost request. Releasing inputs the mint has already consumed,
or abandoning outputs it has already signed, loses value.

Each operation defines what counts as positive evidence next to its recovery code. Examples are a
fresh `UNPAID` Melt Quote observation confirmed under the operation lock, an allowlisted rejection
of the first submission, and for Receive, spent inputs together with a well-formed empty Restore
and no local output. A rejected replay says nothing about an earlier attempt. Recovery applies
results through the same transitions as initial execution, and local settlement records only what
the Wallet holds; it never invents the mint's accounting.

## Considered Options

- **Fail after a timeout or a retry budget.** Rejected because operation age does not establish
  whether a remote attempt finished.
- **Build a new request when retrying.** Rejected because the earlier submission may already have
  affected the mint. Changed request material requires a new operation.

## Consequences

An operation can stay unresolved indefinitely when a mint never provides conclusive evidence.
Resolving it is explicit Operation Recovery or Restore, never automatic failure.
