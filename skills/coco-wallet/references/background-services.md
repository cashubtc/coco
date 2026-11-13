# Background services

Read when configuring automatic wallet progress, suspending background work, or diagnosing an
operation that is not advancing. Keep `initializeCoco()` defaults when they meet the app's needs.

## Responsibilities

| Configuration entry                     | Responsibility                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchers.mintOperationWatcher`         | Observe canonical mint quotes and quotes referenced by pending Mint Operations for BOLT11, BOLT12, and onchain payments. Persist observations before operation advancement.                          |
| `processors.mintOperationProcessor`     | React to mint quote updates, claim available value, and advance Mint Operations according to the session's auto-claim policy.                                                                        |
| `watchers.meltQuoteWatcher`             | Observe canonical melt quotes, retaining operation-owned interest while pending melts need settlement, including after quote expiry.                                                                 |
| `processors.meltSettlementProcessor`    | React to melt quote updates and reconcile interested pending Melt Operations through Coco's settlement workflow.                                                                                     |
| `processors.mintSwapOperationProcessor` | Advance eligible Mint Swap parents from canonical child observations. It never pays an untouched prepared parent.                                                                                    |
| `watchers.proofStateWatcher`            | Observe the proofs of pending Sends becoming spent and submit that evidence to Send, which completes the outgoing Send Operation. Other inflight proofs, including unowned ones, are not reconciled. |

The proof-state watcher does not reconcile newly restored `pending` proofs. Those remain
unavailable until repeated [Restore](restore.md) establishes their state. Watchers and processors
also do not execute prepared Send, Receive, or Melt operations on the user's behalf.

## Select the policy at initialization

Pass `watchers` and `processors` in the `initializeCoco()` config. Each entry supports
`disabled: true`; omitting it keeps that service enabled. Disabling a watcher stops that source
of automatic observation. Disabling a processor leaves observed quote state without that
automatic operation advancement. Neither setting cancels persisted operations or disables
explicit quote/operation APIs. Startup Operation Recovery for Send, Melt, payment-request Receive, Mint and Batch Mint is separate
and still runs even with every owner omitted. Mint Swap automatic recovery retains its own
`processors.mintSwapOperationProcessor.disabled` selection.

Disabling the Mint Swap processor pauses automatic parent progression and does not hand active
children to ordinary processors. Explicit `ops.mintSwap.refresh(id)` and
`ops.mintSwap.recovery.run()` remain available. There is no runtime pause/resume toggle; owner
selection is fixed for the Coco Session.

For app-controlled mint claims, use `processors.mintOperationProcessor.autoClaimMintQuotes: false`
and follow [Reusable quote claims](quote-operations.md#reusable-quote-claims). That reference owns
the session-wide policy and required explicit reconciliation; disabling the processor entirely
also removes its processing of explicitly requeued work.

Startup scan options control whether a service discovers existing records when it starts:

- Mint watcher: `watchExistingPendingOnStart` and `watchExistingPendingQuotesOnStart`.
- Melt watcher: `watchExistingPendingQuotesOnStart`.
- Proof-state watcher: `watchExistingInflightOnStart`.
- Melt settlement processor: `initializeExistingPendingOperationsOnStart`.

These default to true. Turning a scan off does not prevent processing new events and is not a
general opt-out from recovery. If the app skips a scan, give persisted work another discovery
and reconciliation path through quote/operation list and refresh/recovery APIs.

For transport cadence, `subscriptions.slowPollingIntervalMs` controls backup polling while
WebSocket is connected; `fastPollingIntervalMs` controls fallback polling after WebSocket failure.
These are observation intervals, not payment deadlines. Mint processor options
`processIntervalMs`, `initialEnqueueDelayMs`, `maxRetries`, and `baseRetryDelayMs` govern its queue
and bounded network-error retries. They do not configure every service's retry policy. The melt
settlement processor relies on later notifications or explicit refresh after transient failures.

Use the installed `CocoConfig` declarations for supported options and the
[Watchers and Processors guide](https://cashubtc.github.io/coco/pages/watchers-processors) and
[Subscriptions guide](https://cashubtc.github.io/coco/starting/subscriptions) for API details.

## Control the running session

Choose all six owners and their options during initialization for the Coco Session's lifetime.
The Mint, Melt and Proof watcher pairs and the Mint, Melt settlement and Mint Swap processor
pairs of runtime enable/disable methods are removed. `disabled: true` omits an owner throughout
the session. A different selection requires a new Session, with its normal startup recovery.
No persistence migration is required.

Use `ensureSubscriptions()` on app foreground. It replaces stale sockets, replays existing
registrations, and ensures polling runs while preserving current owner settings and interests.
It resolves after local initiation, even offline, without waiting for connectivity or catch-up.
It does not rerun startup discovery or operation recovery. Normal observations may still persist
canonical state and trigger enabled processors; already-started polling commits may finish.

The old pause/resume APIs and events are removed. Migration loses coordinated background quieting:
removing a background pause leaves enabled polling and work running. Keep app-owned foreground plugin sync, paid-quote
requeueing and catch-up explicit; networking repair does not perform them. Teardown uses `dispose()`. If the app depended on resume's
standalone Mint and Batch Mint recovery, call `ops.mint.recovery.run()` and
`ops.mint.batch.recovery.run()` explicitly when needed. Final shutdown cannot be repaired or resumed.

## Diagnose stalled work

Load the canonical quote and existing operation before choosing an action. Check whether the
quote changed but the operation did not, whether background services are disabled,
whether startup discovery was skipped, and whether authentication or mint trust needs attention.
An observed quote payment alone does not prove proofs were stored or a melt finalized.

Use `quotes.mint.refresh()` / `quotes.melt.refresh()` for explicit quote observation and the
matching `ops.<flow>.refresh(id)` or recovery API for operation reconciliation. Explicit quote
checks target the requested quote without requiring Background Watcher interests. Follow the
flow's state-specific rules; prepared work still needs a decision, and ambiguous execution needs
reconciliation of the existing operation before another attempt. See
[Shared mint and melt lifecycle](quote-operations.md) and [Mint authentication](auth.md).

**Done when:** the selected policy progresses new and persisted work, foreground repair preserves the
intended policy, and a delayed observation or retry never becomes an unproven failure or a new
replacement payment.
