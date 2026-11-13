---
'@cashu/coco-core': minor
---

Add `initializeCocoWithRestore` to restore caller-selected mints before activating plugins,
Background Watchers, Background Processors, and startup Operation Recovery. Expose per-keyset Restore
reports and progress, with cancellation between keysets and partial results on initialization failure.
