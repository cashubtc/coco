---
status: accepted
---

# Fix background owner selection for a Coco Session

Background Watchers and Background Processors, and their options, are selected during initialization
for the lifetime of a Coco Session. There are no public enable or disable controls and no internal
restart machinery. Startup configuration can omit an owner for the entire session. Runtime controls
let owners be replaced independently, which required dependency rebinding, transfer of observation
interests, and coordination between draining owners and replacement owners.

Owner disable flags omit the selected Background Watcher or Background Processor. They do not
suppress the initializer's one-time Operation Recovery runs, so disabling every owner does not
promise an initialization free of automatic mint requests or operation advancement.

This decision assumes Wallet Import preparation can precede automatic work; the API discussed in
[issue #604](https://github.com/cashubtc/coco/issues/604) remains undecided. Networking-only
subscription repair through `ensureSubscriptions()` does not activate owners or run Operation
Recovery. Final disposal guarantees are unchanged, including the proof watcher's allowance for
already-started work to finish: this decision does not supersede
[ADR-0014](0014-let-proof-watcher-shutdown-finish-started-work.md). Temporary background suspension
and any change to shutdown guarantees require separate decisions.

Every Coco Session starts through `Manager.create()`, which `initializeCoco()` delegates to. The
`Manager` constructor is private, and there is no manual sequence of direct construction, plugin
initialization and per-owner enables. A Manager whose owners were never started would be a lifecycle
state that fixed selection exists to remove.

There are no automatic watcher registration retry timers, and without enable controls there is no
explicit failed-activation retry trigger. Error reporting, retained interests, and declaration- and
event-driven retry paths remain. Ordinary remote connection failures are distinct from local
activation failures. Transport setup failure handling and a policy for retrying failed storage reads
are undecided.

The trade-off is loss of arbitrary runtime reconfiguration in exchange for fixed ownership and
fewer lifecycle transitions. Merely hiding the controls would not have delivered that benefit.
Subscription acquisition and release, changing observation interests, network repair, startup
failure cleanup, and final disposal still need lifecycle coordination.
