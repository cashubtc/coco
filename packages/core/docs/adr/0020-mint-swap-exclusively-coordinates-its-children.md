---
status: accepted
---

# Mint Swap exclusively coordinates its children and keeps its authority after trust revocation

While a Mint Swap Operation can still act, it is the only coordinator of its source Melt Operation
and destination Mint Operation. Ordinary Mint and Melt commands that would change a child or use its
quote reject with `MintSwapChildOperationError`, which carries the `parentOperationId`. Background
Processors, automatic claiming and ordinary Operation Recovery skip those children. Reads and shared
Quote Observations continue. Otherwise ordinary background processing could advance a child while
the parent's own processing is disabled.

A terminal or `needs_attention` parent never acts again, so its children return to ordinary
resolution: recovery, processors, claiming, and commands that observe, settle, release or issue.
Keeping exclusivity would strand reserved source proofs, in-flight Melts and paid destination
quotes. The release is one-way. Ordinary coordination still never pays a stopped parent's source:
Melt preparation against its source quote and execution of its prepared source reject with
`parentStopped`, because the stop may record evidence against paying.

Both mints must be trusted in the transaction that records the initial source authorization. After
that commit, revoking trust in either mint does not interrupt the authorized payment, its
observation, settlement or recovery, and a funded parent can still redeem the destination quote.
The source payment may have succeeded before its observation was persisted, so stopping on
revocation would strand paid value. Recovery never restores trust, never replaces an output plan and
never dispatches the source payment again. Ordinary Mint execution keeps its trust gate.

The parent is found through durable reverse lookups over immutable child IDs and quote references.
It is never stored on the child or inferred from a scan of active parents.

## Considered Options

- **Let ordinary commands and processors act on a child beside its parent.** The first design;
  replaced because ordinary processing could advance a child while the parent's processing was
  disabled.
- **Keep exclusivity after the parent stops.** Rejected because a stopped parent has no outgoing
  transitions and its children's value would be stranded.
- **Stop an authorized swap when trust is revoked.** Rejected because paid value would be stranded.

## Consequences

One effect-driving Coco Session per Wallet store is required. The child operation locks that the
parent shares with the ordinary Mint and Melt services are in-memory and do not fence network
effects across sessions. Core adds no cross-process lock; hosts keep their own session guards.
