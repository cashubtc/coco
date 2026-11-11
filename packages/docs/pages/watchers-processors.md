# Watchers and Processors

`initializeCoco()` selects all Background Watchers and Background Processors by default.
Selection **and options are fixed for the lifetime of that Coco Session**. Set `disabled: true`
to omit an owner for the entire session. There are no runtime enable/disable controls.

The initializer still runs one-time Send, Melt, payment-request Receive (including pending Receive),
and Mint/Batch Mint Operation Recovery, even when every owner is disabled. Mint Swap automatic
recovery retains its separate `mintSwapOperationProcessor.disabled` selection. Disabled owners do
not promise initialization without mint requests or operation advancement. Explicit operations and
recovery APIs remain available.

Watchers observe the mint and persist canonical evidence before notifying processors. Processors
reassess persisted evidence at startup and on runtime events; event payloads do not override current
Wallet state. Mint and Melt watchers and processors can be selected independently at initialization. With a processor
enabled and its watcher disabled, cached evidence or an explicit quote refresh can drive advancement.
With only the watcher enabled, observations update quotes without automatically advancing operations.
With both disabled, explicit operation APIs such as `refresh()` and `checkPayment()` remain available.
Startup recovery sweeps still run independently of these switches and can advance pending operations.

To disable them during initialization with `initializeCoco()`:

```ts
const coco = await initializeCoco({
  repo,
  seedGetter,
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
    mintSwapOperationProcessor: { disabled: true },
  },
});
```

## MintOperationProcessor

This module discovers locally claimable Mint Quotes and pending Mint Operations at startup, including
operations whose canonical quotes are already complete. It reassesses canonical accounting on quote
updates and newly pending operation events. It supports BOLT11, BOLT12 and onchain quotes, including
reusable quotes with remaining claimable value. Executing an eligible transition may issue proofs or
restore previously issued outputs; those effects are separate from observing quote state.

`autoClaimMintQuotes: false` suppresses the processor's startup and runtime automatic quote claims.
It still handles explicit operation requeue events. Disabling the processor suppresses both kinds
of processor-owned work.

With `batchMintQuotes` (default `true`), claims from quote updates are collected over one processing
turn (`processIntervalMs`) and, like the startup sweep, grouped into Batch Mint Operations per mint,
method and unit when the mint supports NUT-29 batch minting. See
[Coco config](./coco-config.md) for the fallback rules.

::: warning Payment waiters must handle batch completion
With automatic batching enabled, a successfully claimed quote may emit `batch-mint-op:finalized`
without any `mint-op:finalized` event. A waiter listening only to `mint-op:*` can hang even though
the proofs have been saved. Handle both event families by mint URL and quote ID, or set
`processors.mintOperationProcessor.batchMintQuotes: false` to retain standalone automatic claims.
See [Awaiting automatically claimed payments](./mint-operations.md#awaiting-automatically-claimed-payments)
for subscription, persisted-state reconciliation and cleanup guidance.
:::

## MintOperationWatcher

This module watches pending Mint Operations and Mint Quotes via WebSockets and polling, persists remote
observations, and emits canonical quote updates. It supports BOLT11, BOLT12 and onchain quotes. It does
not finalize operations itself.

## MeltQuoteWatcher

This module watches canonical pending melt quotes via WebSockets and polling, records remote quote
observations, and emits canonical `melt-quote:updated` events. It also keeps operation-owned quote
interest active for pending melt operations, including expired quotes, until settlement finalizes or
rolls back.

The Melt processor declares operation-owned observation interest synchronously. The watcher owns
asynchronous trust checks and subscription setup; registration means local acceptance, not readiness
or remote subscription acceptance. Initialization can therefore return while setup for those
operation-owned interests is still pending. Cached-evidence progression does not wait for setup.

Setup failures are logged with quote and operation context. There is no new retry loop: another
pending-operation declaration can retry failed or skipped setup. Existing quote events and parent
scans also retain their declaration paths. No automatic registration retry timer is added. Ordinary
network failure is different from local registration failure: subscription setup does not wait for
remote acceptance.

Removing operation interest withdraws it immediately and waits for any cleanup it requires. Canonical
and other operation interests keep shared watches active. Stopping or untrusting the watcher
invalidates affected records before waiting for acquisition and unsubscribe cleanup, including records
already being retired. Old acquisitions and callbacks cannot take ownership of replacement watches.

## MeltSettlementProcessor

This module reacts to canonical melt quote update events for interested pending melt operations and
advances them through the existing melt operation saga. It starts with existing pending melt
operations by default, suppresses concurrent checks for the same operation, and relies on later
quote notifications or manual refresh after transient failures.

The processor uses cached canonical settlement evidence without fetching fresh quote state to decide
eligibility. Waiting quotes and incomplete cached PAID change leave operations pending. Complete
matching PAID observations normalize omitted change to empty change at the observation boundary;
incomplete stored evidence must be enriched by a valid observation or explicit refresh. Settlement
still validates quote identity and proof ownership through the operation service and may fetch
metadata to unblind change. Before releasing inputs from UNPAID evidence, it confirms nonpayment
under the shared operation lock. This narrow safety check also applies to a Mint Swap source child
once its parent stops and releases it to ordinary processing; an active parent coordinates its child
instead. It does not add polling for pending or incomplete quotes.

`initializeExistingPendingOperationsOnStart: false` skips startup discovery while preserving listeners
for operations that become pending during this run, including later quote observations for them.
Operations already pending before the processor started are not tracked, so a quote observation does
not advance them; use an explicit operation check such as `coco.ops.melt.refresh()` instead.

## ProofStateWatcher

This module observes proofs belonging to pending Sends and submits SPENT evidence to the Send
operation service. The proof changes and any resulting Send completion commit atomically; the
watcher never writes proofs itself. Its startup scan uses local evidence to discover pending Sends,
including those whose proofs are already locally spent and supported legacy tokenless P2PK Sends
whose output proof rows were not retained. Operation Recovery owns the startup mint checks; discovery
installs subscriptions without waiting for or repeating those requests. The subscription transport
continues to observe through polling and WebSocket notifications. Legacy completion still requires
remote verification of the complete output allocation, through recovery or a new proof observation,
and the original input metadata; it does not fabricate proofs or a token.

Unowned inflight proofs, including records whose referenced operations are missing or terminal,
are no longer automatically reconciled. This retires the old compatibility fallback. Restore's
unowned ready and pending proofs are unaffected; other operation types retain their own recovery.

`watchExistingInflightOnStart: false` skips startup subscription discovery, but does not disable
Operation Recovery. Live proof events and newly pending Sends remain observed while the watcher runs.

`await coco.dispose()` stops proof observation and discovery, cancels pending discovery timers,
and releases subscriptions, including those acquired during shutdown. Proof watcher shutdown waits
for subscription acquisition and cleanup, but does not drain already-started notification processing
or operation checks. Those calls may finish Wallet updates and publish events afterward. A proof or
Send completion listener can await disposal without waiting on its own completion (ADR-0014).

Disposal is not a completion barrier for started proof updates or Send completion. Keep caller-owned
storage available while that work finishes. Other owners retain their own drain guarantees. Disposal
is neither process death nor a universal barrier against explicit commands.

The Mint and Melt quote watchers instead drain the work they own, including publishing quote events
from their notifications. Do not await `coco.dispose()` from an awaited
`mint-quote:updated` or `melt-quote:updated` listener: shutdown would wait on the listener that is
waiting on shutdown.

## Repairing foreground networking

Call `await coco.ensureSubscriptions()` after returning to the foreground. It replaces potentially
stale WebSockets and ensures polling continues, preserving current interests and owner settings.
Its promise covers local initiation only, so it is safe offline and does not promise catch-up or
operation completion. Existing polling requests may still commit canonical observations.

Repair does not restart watchers or processors, rerun startup discovery, or recover operations.
Use initialization configuration for owner selection, explicit operation recovery for reconciliation,
and `dispose()` for final shutdown. Foreground repair does not replace background suspension or
app-owned plugin synchronization, paid-quote requeueing and catch-up. See
[Subscriptions](../starting/subscriptions.md) for foreground examples and the networking migration.

## Fixed-owner migration

All six public pairs are removed: `enableMintOperationWatcher` / `disableMintOperationWatcher`,
`enableMeltQuoteWatcher` / `disableMeltQuoteWatcher`, `enableProofStateWatcher` /
`disableProofStateWatcher`, `enableMintOperationProcessor` / `disableMintOperationProcessor`,
`enableMeltSettlementProcessor` / `disableMeltSettlementProcessor`, and
`enableMintSwapOperationProcessor` / `disableMintSwapOperationProcessor`.

Move selection and options into `initializeCoco({ watchers, processors })`. Replace final-cleanup
calls to individual disables with `await coco.dispose()`. A different selection requires a new
Coco Session, including its normal startup recovery. There is no persistence migration.

Direct `new Manager(...)` construction and `initPlugins()` are removed with the manual activation
sequence. Start every Coco Session with `initializeCoco()` or `Manager.create()`.

`ensureSubscriptions()` never activates an omitted owner or performs a recovery sweep.

### Shared Mint Swap observation

Mint Swap parents declare interests in the existing Mint and Melt quote watchers. These use the same
synchronous local acceptance contract as ordinary operation interests; setup and failure diagnostics
belong to the watcher. Parent progression from cached evidence does not await subscription acquisition.
Final disposal withdraws parent interests and waits for required cleanup. Interest withdrawal also
happens as parents progress, preserving shared interests. Initialization may finish while
operation-owned acquisition is still pending. Selected watcher dependencies never change.

Normal parent scans use cached evidence. Startup prefers sufficient cached evidence but currently
retains bounded recovery for unresolved observations and already-authorized destination accounting.
Explicit refresh/recovery remains available, and source proof release still requires fresh nonpayment confirmation under the shared child lock.
