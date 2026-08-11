# Keep explicit quote checks target-isolated

An Explicit Quote Check is caller-scoped work. It checks only the requested quote through the
single-quote endpoint and never recruits or waits for Background Watcher interests. An unrelated
quote therefore cannot make the explicit caller fail.

Background Watchers may batch compatible mint quote checks by normalized mint and Built-in Payment
Method. When a batch opportunity reports definitive incompatibility, batch-size rejection, a
malformed response, or validation rejection, Coco marks only that mint-and-method group batch
unavailable for the current Coco Session. The failed opportunity performs no individual fan-out.
Later polling turns check one quote at the configured cadence, preserving normal fairness and
requeueing behavior.

Network failures, authentication interruptions, rate limits, and server failures do not set the
marker. A successful mint metadata refresh clears the affected mint's markers, and a new Coco
Session starts without downgrade state. The policy has no recursive splitting, adaptive learned
limit, internal retry loop, or persisted compatibility state.
