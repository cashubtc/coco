---
status: accepted
---

# Fix background owner selection for a Coco Session

Runtime enable and disable controls allow Background Watchers and Background Processors to be
replaced independently, requiring dependency rebinding, transfer of observation interests, and
coordination between draining owners and replacement owners. Select these owners and their options
during initialization for the lifetime of a Coco Session, retire both public enable and disable
controls, and remove the corresponding internal restart machinery. Startup configuration still
allows an owner to be omitted for the entire session.

Owner disable flags retain their existing scope: they omit the selected Background Watcher or
Background Processor, without suppressing the initializer's existing one-time Operation Recovery
runs. Disabling every owner therefore does not promise an initialization free of automatic mint
requests or operation advancement. Changing startup recovery policy is outside this refactor.

This decision assumes Wallet Import preparation can precede automatic work; the API discussed in
[issue #604](https://github.com/cashubtc/coco/issues/604) remains undecided. The agreed networking-only
subscription repair is a separate change and does not activate owners or run Operation Recovery.
Preserve existing final disposal guarantees in this refactor, including the proof watcher's
allowance for already-started work to finish. Temporary background suspension and any changes to
shutdown guarantees require separate decisions. In particular, this decision does not supersede
[ADR-0014](0014-let-proof-watcher-shutdown-finish-started-work.md).

Start every Coco Session through `Manager.create()`, which `initializeCoco()` delegates to. The
`Manager` constructor is private, and the manual sequence of direct construction, `initPlugins()` and
per-owner enables is retired rather than replaced. A Manager whose owners were never started would be
a lifecycle state that fixed selection exists to remove.

Do not add automatic watcher registration retry timers in this refactor. Removing enable controls
also removes their explicit failed-activation retry trigger; preserve error reporting, retained
interests, and existing declaration- and event-driven retry paths. Ordinary remote connection
failures are distinct from local activation failures. Transport setup failure handling and a policy
for retrying failed storage reads remain separate follow-ups.

The trade-off is loss of arbitrary runtime reconfiguration in exchange for fixed ownership and
fewer lifecycle transitions. Merely hiding the existing controls would not deliver that benefit.
Subscription acquisition and release, changing observation interests, network repair, startup
failure cleanup, and final disposal still need lifecycle coordination.
