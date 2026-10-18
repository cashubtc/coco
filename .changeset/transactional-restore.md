---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-adapter-tests': minor
---

Restore now imports proofs and advances counters atomically per keyset, preserving the durable counter high-water mark and existing operation ownership. Newly restored mint-held proofs use the new `pending` state and reconcile through the proof watcher or a repeated Restore.

Finish pending proof subscription cleanup before publishing readiness so a Send started by an event listener keeps its replacement subscription.

Recheck proof state and subscription identity when processing readiness events, including newer watch requests made during an asynchronous read. Pending-proof listeners can await watcher shutdown without deadlocking: shutdown cancels remaining delivery while still draining active transactions and subscription acquisition. EventBus publication accepts an optional AbortSignal; delivery without a signal retains its existing behavior.

Remove the plugin-facing `CounterService.overwriteCounter()` method. Custom proof repositories must implement `getPendingProofs()`. SQL adapters migrate their proof-state constraint while preserving existing records; IndexedDB accepts the additional state. Pending proofs remain excluded from existing balances. Melt inputs still use `inflight` pending a separate migration.
