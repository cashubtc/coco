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

A stale-keyset rejection refreshes the Known Mint through Coco and rebuilds the Wallet Instance.
After Coco proves that the Exact Operation Request was not applied, the affected operation rolls
back and reports a Stale Keyset Failure. Coco neither mutates the original request nor replays
outputs derived from a stale snapshot; the caller must prepare a new operation.

Stale cleanup is serialized through Coco's shared mint lock. It invalidates every cached Wallet
Instance for the Known Mint, forces one persisted mint/keyset refresh, and rebuilds only the unit
needed by the caller. If the network refresh fails, Coco retains a persisted refresh requirement so
a restart cannot treat the old snapshot as fresh.
