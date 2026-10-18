---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-adapter-tests': minor
---

Automatically reconcile unowned pending proofs at trusted mints under the existing proof-state watcher setting. Recheck state and ownership atomically before releasing a proof or marking it spent, and safely drain subscription acquisition and writes on shutdown. Existing Send/Melt handling and balance semantics are unchanged.

Custom proof repositories must implement `getPendingProofs()`, returning all pending proofs across mints and units, including operation-owned records. The watcher filters ownership. Built-in adapters implement the query without a schema change. EventBus emission accepts an optional cancellation signal that suppresses subsequent listeners while allowing an already-running listener to finish.

Shared subscription handles now remove only their own callback. Hybrid transport forwards repeated proof-state observations so a failed local reconciliation can retry on the next poll; quote deduplication is unchanged.
