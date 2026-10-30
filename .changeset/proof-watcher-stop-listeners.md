---
'@cashu/coco-core': patch
---

Allow event listeners to await proof-state watcher shutdown without deadlocking on their own
notification processing. Shutdown still waits for subscription acquisition and releases late
subscriptions, while already-started operation checks and event publication may finish afterward.
