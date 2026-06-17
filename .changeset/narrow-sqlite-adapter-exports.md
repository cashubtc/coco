---
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-expo-sqlite': major
---

Narrow SQLite adapter package exports to the repository aggregate and option types.

Applications should use `SqliteRepositories` as the adapter entry point. The packages no longer
export individual repository classes, database wrapper classes, migration arrays, or schema helper
functions.
