---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': patch
---

Replace `Manager.pauseSubscriptions()` / `resumeSubscriptions()` and `SubscriptionManager.pause()` / `resume()` with `ensureSubscriptions()`. It replaces stale WebSockets, replays subscriptions, and re-arms polling while preserving callbacks and watcher/processor settings. Overlapping calls coalesce. Completion means local networking repair was initiated; it does not guarantee connectivity or run operation recovery.

Remove the `subscriptions:paused` / `subscriptions:resumed` events and replace `RealTimeTransport.pause()` / `resume()` with synchronous `ensure(): void`.

Update the published adapter integration harness to use final disposal for teardown and exercise foreground repair.
