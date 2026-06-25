---
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Rename the operation row hydration guard to `assertFieldPresent` and turn it into a TypeScript assertion function, since it checks for presence rather than that a value is a number. Remove the now-unused copies left in the expo-sqlite and sqlite3 adapter utils after the shared SQL storage migration.
