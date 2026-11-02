# Keep explicit quote checks target-isolated

An Explicit Quote Check is caller-scoped work. A single-quote check uses the requested quote through the
single-quote endpoint and never recruits or waits for Background Watcher interests. An unrelated
quote therefore cannot make the explicit caller fail.

Background Watchers may batch compatible mint quote checks by normalized mint and Built-in Payment
Method. When a batch opportunity reports definitive incompatibility, batch-size rejection, a
malformed response, or validation rejection, Coco marks only that mint-and-method group batch
unavailable for the current Coco Session. The failed opportunity performs no individual fan-out.
Later polling turns check one quote at the configured cadence, preserving normal fairness and
requeueing behavior.

Network failures, authentication interruptions, rate limits, and server failures do not set the
marker. An applied and committed mint metadata refresh clears the affected mint's markers;
ignored older observations and timestamp ties do not publish a refresh event or clear the markers.
A new Coco Session starts without downgrade state. The policy has no recursive splitting,
adaptive learned limit, internal retry loop, or persisted compatibility state.

Batch Mint Operation Recovery is scoped to the exact persisted member set, not to one quote.
After Restore returns no outputs, it checks those members together through the NUT-29 batch
quote-check endpoint. This avoids one network round trip per member without recruiting or waiting
for Background Watcher interests. It uses the currently advertised method support and safety-capped
batch size; if that limit has shrunk since admission, only the quote checks are chunked. The Exact
Operation Request is never split or regenerated.

Recovery records attributable Quote Observations before acting, but requires complete, valid,
non-conflicting evidence for every requested member before replaying or failing the operation.
Missing, duplicate, unrequested, malformed, stale or impossible observations leave the outcome
unresolved. Valid observations can still be retained when another member's observation fails.
Unavailable or unsupported batch checks also leave the operation executing with its reservations;
there is no fallback to individual checks. Recovery neither consults nor changes the Background
Watcher batch-compatibility marker, so a failed polling opportunity cannot disable explicit recovery.
