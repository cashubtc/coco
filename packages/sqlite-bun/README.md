# @cashu/coco-sqlite-bun

> ⚠️ Release candidate: Coco is stabilizing for v1, but breaking changes may
> still land before the final 1.0 release. Pin versions in production.

SQLite adapter for Coco using Bun's built-in `bun:sqlite` module.

## Install

```bash
bun add @cashu/coco-core @cashu/coco-sqlite-bun
```

## Usage

```ts
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';

const database = new Database(':memory:');
const repositories = new SqliteRepositories({ database });
await repositories.init();

const manager = await initializeCoco({
  repo: repositories,
  seedGetter,
});
```

## Notes

- Uses `bun:sqlite` instead of `better-sqlite3`.
- Designed specifically for Bun runtime.
- No external SQLite dependency is required.

## Testing

```bash
bun test
```
