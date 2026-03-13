# coco-cashu-sqlite-bun

SQLite adapter for coco-cashu using Bun's built-in `bun:sqlite` module.

## Installation

```bash
npm install coco-cashu-sqlite-bun
```

## Usage

```typescript
import { SqliteStorage } from 'coco-cashu-sqlite-bun';
import { initializeCoco } from 'coco-cashu-core';
import { Database } from 'bun:sqlite';

const database = new Database(':memory:');
const storage = new SqliteStorage({ database });

const coco = await initializeCoco({
  storage,
  seedGetter,
});
```

## Differences from coco-cashu-sqlite3

- Uses `bun:sqlite` instead of `better-sqlite3`
- Designed specifically for Bun runtime
- Uses `bun:test` for testing instead of vitest
- No external SQLite dependencies required

## Testing

```bash
bun test
```
