# @cashu/coco-sqlite-bun

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

SQLite adapter for Coco using Bun's built-in `bun:sqlite` module.

## Installation

```bash
bun add @cashu/coco-core @cashu/coco-sqlite-bun
```

## Usage

```typescript
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

## Differences from @cashu/coco-sqlite

- Uses `bun:sqlite` instead of `better-sqlite3`
- Designed specifically for Bun runtime
- Uses `bun:test` for testing instead of vitest
- No external SQLite dependencies required

## Testing

```bash
bun test
```
