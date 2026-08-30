---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-indexeddb': minor
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Add the generic durable event outbox contracts, publisher, transactional consumer coordinator,
memory and IndexedDB repositories, shared adapter conformance tests, and SQL migration 039.

The foundation remains opt-in: hosts own the physical transaction and scheduling, and feature
integrations supply their own transaction-bound writer and local consumer scope.
