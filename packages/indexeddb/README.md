# @cashu/coco-indexeddb

> ⚠️ Release candidate: Coco is stabilizing for v1, but breaking changes may
> still land before the final 1.0 release. Pin versions in production.

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
