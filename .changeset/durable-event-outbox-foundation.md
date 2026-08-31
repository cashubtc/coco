---
'@cashu/coco-core': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-indexeddb': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-expo-sqlite': minor
---

Add the generic durable event outbox contracts, publisher, transactional consumer coordinator,
public memory transaction port, IndexedDB repository and transaction port, shared adapter
conformance tests, SQL migration 039, and public SQLite3, Bun SQLite, and Expo SQLite outbox
transaction capabilities.

The foundation remains opt-in: hosts own scheduling, adapters expose physical transaction ports,
and feature integrations supply their own transaction-bound writer and local consumer scope.
