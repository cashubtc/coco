---
'@cashu/coco-sqlite': patch
---

Declare `@types/better-sqlite3` as a package dependency so downstream TypeScript
consumers can resolve public SQLite adapter declarations without installing the
type package manually.
