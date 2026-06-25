---
'@cashu/coco-core': patch
'@cashu/coco-react': patch
---

Make `Manager.dispose()` stop manager-owned watchers, processors, subscriptions, and plugin
resources, and let the React provider rely on core disposal directly.
