---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sql-storage': major
'@cashu/coco-adapter-tests': major
'@cashu/coco-react': major
---

Replace public repository setup with opaque storage factories and `CocoConfig.storage`. Keep the
supported manual Manager constructor accepting storage; recommend initializeCoco for complete startup.
IndexedDB initialization now awaits opening and migrations, and its handle provides close(). SQLite
connections remain caller-owned. Persisted Wallet formats and recovery remain compatible.

Retire core's stable /adapter entry point and repository exports. Explicit /internal entry points and
adapter test helpers have no compatibility or versioning guarantees, even across patch/minor releases.
Coco-owned storage packages must match core's release version, checked before database access.

Publish @cashu/coco-sql-storage with a supported SQLite driver contract, storage factory, typed
transaction conflict error and /test conformance suite. Drivers own connection pragmas; shared SQL
respects declared parameter limits. Independent driver versions need not match Coco.
