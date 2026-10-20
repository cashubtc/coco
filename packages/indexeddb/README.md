# @cashu/coco-indexeddb

IndexedDB storage adapter for Coco in browser and worker environments.

## Install

```bash
npm install @cashu/coco-core @cashu/coco-indexeddb
```

## Usage

```ts
import { initializeCoco } from '@cashu/coco-core';
import { createIndexedDbStorage } from '@cashu/coco-indexeddb';

const storage = createIndexedDbStorage({ name: 'coco' });
await storage.init();

const manager = await initializeCoco({
  storage: storage,
  seedGetter,
});
```

## Notes

- Pass `name` to control the IndexedDB database name. The default is `coco_cashu`.
- This adapter is intended for environments where IndexedDB is available.

`initializeCoco` automatically awaits `storage.init()`, which opens IndexedDB and completes migrations.
For supported manual startup, await `storage.init()` before `new Manager(storage, seedGetter)`.
Finish all Wallet work, dispose the session, then call `storage.close()` to release the connection.
Closure does not delete Wallet data. Session disposal does not close storage automatically.
No new reopening or operation-draining guarantee is implied.

Use matching Coco core and adapter releases. `/internal` exports have **no compatibility or versioning
guarantees, including patch/minor releases**; repository implementations are not a supported API.
