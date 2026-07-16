# Keep explicit quote checks target-isolated

NUT-29 quote checking rejects the complete request when any member is unknown or malformed. Coco
therefore keeps an Explicit Quote Check target-isolated: it checks only the requested quote and may
join only identical target-only work, so an unrelated Background Watcher interest cannot make the
caller fail.

Background Watchers and Mint Issuance Attempt recovery may still batch compatible quote checks.
Because those requests are atomic, a confirmed validation rejection is split deterministically
until invalid singleton quotes are isolated; successful sub-batches continue through normal
Attributable Quote Observation persistence. This gives up some foreground batching opportunity in
exchange for predictable explicit-call behavior and fault isolation.
