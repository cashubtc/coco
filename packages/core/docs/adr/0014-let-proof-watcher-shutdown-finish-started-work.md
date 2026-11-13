---
status: accepted
---

# Let proof watcher shutdown leave started work to finish

The proof-state watcher is the one Background Watcher whose shutdown does not drain the processing it
has started. Stopping it, which happens only through Coco Session disposal, stops accepting notifications
and discovery work, cancels pending discovery timers, waits for subscription acquisition, and releases
every subscription, including those acquired while shutdown was waiting. Notification processing and
operation checks that already started may still finish Wallet updates and publish events afterward.

The watcher's work ends in Send completion and proof events, and listeners for those events
legitimately dispose the Coco Session. If shutdown drained that work, a listener awaiting shutdown
would wait on the processing that is waiting on that listener. Withholding the drain lets such a
listener await shutdown safely.

Shutdown is therefore not a completion barrier for proof updates or Send completion. Callers keep
storage available until that work finishes. Other Background Watchers and processors keep their own
documented drain guarantees; this decision does not extend to them or to the Mint Swap parent.

## Considered options

- **Drain started work on shutdown.** Rejected because it deadlocks a listener that awaits shutdown,
  which Send completion and proof event listeners can do.
- **Drain with a timeout.** Rejected because it turns a structural deadlock into a delay of arbitrary
  length and still leaves late work after the timeout.
- **Detect re-entrant shutdown from listeners.** Rejected because the watcher cannot reliably tell
  which awaiting call chain a listener belongs to, and the rule would depend on how the caller
  structures its code.

## Consequences

Applications that need a completion barrier observe the resulting Send or proof event instead of
shutdown. Tests and hosts that close storage immediately after disposing the Coco Session can race the
remaining work.
