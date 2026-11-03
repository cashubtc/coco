---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
---

Replace `Manager.pauseSubscriptions()` / `resumeSubscriptions()` with `ensureSubscriptions()` for app foreground networking repair. It replaces potentially stale WebSockets, replays current logical subscriptions, and ensures polling schedules run without overlapping requests. Current callbacks and watcher/processor settings are preserved. Overlapping calls coalesce, retired socket callbacks are fenced, and Hybrid delivery deduplication resets so fresh observations can reach callbacks again.

Completion means local repair was initiated, not remote connectivity, observation catch-up, or operation completion. Calls are safe offline and do not restart owners, rerun startup discovery, or run Operation Recovery. Normal observations may still persist canonical state and trigger enabled processors; in-flight polling commits are not cancelled.

Breaking: remove `SubscriptionManager.pause()` / `resume()` (including `manager.subscriptions` and plugin `ServiceMap.subscriptions`) and `subscriptions:paused` / `subscriptions:resumed` events. Use `subscriptions.ensureSubscriptions()` for plugin networking repair. Custom injected `RealTimeTransport` implementations must replace `pause()` / `resume()` with synchronous `ensure(): void`, preserve interests, fence retired callbacks, and emit `open` for fresh connections to replay current registrations without duplicating polling tasks.

Replace foreground resume calls with `ensureSubscriptions()`. For background policy, use individual owner enable/disable controls; for teardown, use `dispose()`. The former resume path's unconditional standalone Mint and Batch Mint recovery is deliberately removed: invoke `ops.mint.recovery.run()` and `ops.mint.batch.recovery.run()` independently when needed. Initialization recovery is unchanged. No persisted data or storage adapter migration is required.

Update the published adapter integration harness to use final disposal for teardown and exercise foreground repair.

This migration is not behavior-equivalent to background pause/resume: there is no replacement coordinated background quieting API. Removing a background pause leaves enabled polling and work running. Individual controls do not globally pause all transports or plugin registrations. Preserve app-owned foreground plugin synchronization, paid-quote requeueing and catch-up, and any staged owner enabling after Restore readiness; networking repair does none of these.
