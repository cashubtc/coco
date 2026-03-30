# @cashu/coco-sqlite-bun

SQLite adapter for Coco using Bun's built-in `bun:sqlite` module.

## Installation

```bash
npm install @cashu/coco-sqlite-bun
```

## Usage

```typescript
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { Database } from 'bun:sqlite';

const database = new Database(':memory:');
const repositories = new SqliteRepositories({ database });
await repositories.init();
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
