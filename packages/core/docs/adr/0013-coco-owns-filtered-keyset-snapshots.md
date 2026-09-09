# Coco owns filtered keyset snapshots

Status: accepted

Wallet Instances use strict Wallet Keyset Snapshots populated through Coco's Known Mint boundary;
cashu-ts does not independently refresh their keychains. This keeps one authoritative, filtered
set of Usable Keysets while Coco cannot use every advertised keyset curve end to end.

## Considered Options

We rejected cashu-ts-owned automatic refresh for now because its in-memory snapshot could admit a
keyset that Coco's proof-state and persistence paths cannot use, then diverge from the persisted
Known Mint.

## Consequences

A stale-keyset rejection marks the Known Mint stale and invalidates every Wallet Instance for that
mint. The next normal Wallet Instance access refreshes the persisted mint and keyset data, then
builds a Wallet Instance for the requested unit. The failing operation does not synchronously fetch
mint metadata.

The affected operation rolls back after the mint's structured rejection proves that its Exact
Operation Request was not applied. Coco neither mutates the original request nor replays outputs
derived from a stale snapshot; the caller must prepare a new operation.

Invalidation advances a cache generation so an in-flight Wallet Instance build cannot repopulate
the cache with the stale snapshot. Marking the persisted Known Mint stale also survives restart and
causes the existing time-to-live check to refresh it on the next access.
