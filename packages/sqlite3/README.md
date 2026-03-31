# @cashu/coco-sqlite

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

Node storage adapter for Coco built on `better-sqlite3`.

## Install

```bash
npm install @cashu/coco-core @cashu/coco-sqlite better-sqlite3
```

## Usage

```ts
import Database from 'better-sqlite3';
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite';

const database = new Database('./coco.db');
const repositories = new SqliteRepositories({ database });
await repositories.init();

const manager = await initializeCoco({
  repo: repositories,
  seedGetter,
});
```

## Notes

- The `coco_cashu_keysets` table no longer has a foreign key to `coco_cashu_mints`. Keysets are deleted manually in the repository when a mint is deleted. This improves compatibility with backends that cannot perform async work inside transactions (e.g., IndexedDB) and avoids FK timing issues during initial sync.
