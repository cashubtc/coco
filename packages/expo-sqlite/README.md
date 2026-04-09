# @cashu/coco-expo-sqlite

> ⚠️ Release candidate: Coco is stabilizing for v1, but breaking changes may
> still land before the final 1.0 release. Pin versions in production.

Expo SQLite storage adapter for Coco in React Native and Expo applications.

## Install

```bash
npm install @cashu/coco-core @cashu/coco-expo-sqlite
npx expo install expo-sqlite
```

## Usage

```ts
import { initializeCoco } from '@cashu/coco-core';
import { ExpoSqliteRepositories } from '@cashu/coco-expo-sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

const database = await openDatabaseAsync('coco.db');
const repositories = new ExpoSqliteRepositories({ database });
await repositories.init();

const manager = await initializeCoco({
  repo: repositories,
  seedGetter,
});
```

## Notes

- Pass an already opened `expo-sqlite` database instance via the `database` option.
- The adapter ensures schema creation and migrations when you call `init()`.
