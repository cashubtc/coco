# @cashu/coco-indexeddb

IndexedDB storage adapter for Coco in browser and worker environments.

## Install

```bash
npm install @cashu/coco-core @cashu/coco-indexeddb
```

## Usage

```ts
import { initializeCoco } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';

const repositories = new IndexedDbRepositories({ name: 'coco' });
await repositories.init();

const manager = await initializeCoco({
  repo: repositories,
  seedGetter,
});
```

## Notes

- Pass `name` to control the IndexedDB database name. The default is `coco_cashu`.
- This adapter is intended for environments where IndexedDB is available.
- The generic durable outbox is opt-in and is not added to the global `Repositories` interface.
  Construct `IdbDurableEventOutboxRepository` only with the caller's active Dexie transaction.
- Before opening a write transaction, declare the complete `IDB_DURABLE_EVENT_OUTBOX_STORES` union
  together with every feature store used by that transaction. Do not await network, timers, or Web
  Crypto while it is active.
- `ensureSchema()` adds the outbox stores and persisted capacity policy. Scheduling remains disabled
  until a feature supplies a tested producer and transactional local consumer.
- An older browser session can reopen the upgraded database and still write stores that it knows.
  Before producer activation, the host must fence or reload old sessions; schema upgrade alone is
  not a writer-compatibility barrier.
