---
'@cashu/coco-core': patch
---

Register Melt operation observation interests synchronously and let the quote watcher own trust
checks, subscription setup, setup failure reporting, and cleanup. Cached-evidence progression no
longer waits for observation setup. Preserve existing retry triggers, shared interests, and awaited
cleanup when interests are removed or the watcher stops.
