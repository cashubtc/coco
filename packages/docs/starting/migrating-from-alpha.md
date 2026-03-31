# Migrating from Alpha

This guide is for teams that tested Coco during the `coco-cashu-*` alpha phase
and now want to move to the current `@cashu/*` release line.

The biggest migration is the namespace change. In most codebases, the move is:

1. Replace old package names in `package.json`
2. Rewrite imports to the new `@cashu/*` names
3. Reinstall dependencies and regenerate your lockfile
4. Switch to the current recommended APIs where the old ones are now deprecated

## Package rename map

| Alpha package | Current package |
| --- | --- |
| `coco-cashu-core` | `@cashu/coco-core` |
| `coco-cashu-indexeddb` | `@cashu/coco-indexeddb` |
| `coco-cashu-expo-sqlite` | `@cashu/coco-expo-sqlite` |
| `coco-cashu-sqlite3` | `@cashu/coco-sqlite` |
| `coco-cashu-sqlite-bun` | `@cashu/coco-sqlite-bun` |
| `coco-cashu-react` | `@cashu/coco-react` |
| `coco-cashu-adapter-tests` | `@cashu/coco-adapter-tests` |

## Update your dependencies

Replace the old alpha package names in your app:

```json
{
  "dependencies": {
    "@cashu/coco-core": "<current @cashu version>",
    "@cashu/coco-indexeddb": "<current @cashu version>"
  }
}
```

Then reinstall:

```sh
npm install
```

If you use Bun:

```sh
bun install
```

## Rewrite imports

Update import paths everywhere the old package names appear.

```ts
// before
import { initializeCoco } from 'coco-cashu-core';
import { IndexedDbRepositories } from 'coco-cashu-indexeddb';

// after
import { initializeCoco } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';
```

React projects follow the same pattern:

```tsx
// before
import { CocoCashuProvider } from 'coco-cashu-react';

// after
import { CocoCashuProvider } from '@cashu/coco-react';
```

## Node users: move from `sqlite3` to `better-sqlite3`

The old `coco-cashu-sqlite3` package has been replaced by
`@cashu/coco-sqlite`, and the adapter now uses `better-sqlite3`.

```sh
npm remove coco-cashu-sqlite3 sqlite3
npm install @cashu/coco-sqlite better-sqlite3
```

```ts
// before
import { SqliteRepositories } from 'coco-cashu-sqlite3';
import { Database } from 'sqlite3';

// after
import { SqliteRepositories } from '@cashu/coco-sqlite';
import Database from 'better-sqlite3';
```

If you are on Bun, prefer `@cashu/coco-sqlite-bun` instead.

## Recommended API updates

Much of the old wallet flow API was rewritten around a saga-based operation
model. The current surface for send, receive, mint, and melt lifecycles now
lives under `OpsApi`, exposed on the manager as `manager.ops.*`.

The old manager aliases are still present in a few places, but the current
operation-oriented API lives under `manager.ops.*`.

Prefer these forms going forward:

```ts
// preferred
await manager.ops.send.prepare({ mintUrl, amount: 100 });
await manager.ops.receive.prepare({ token });
await manager.ops.mint.prepare({ mintUrl, amount: 100, method: 'bolt11' });
await manager.ops.melt.prepare({
  mintUrl,
  method: 'bolt11',
  methodData: { invoice },
});
```

Notes:

- Treat `manager.ops` as the canonical replacement for the older one-shot wallet
  flow helpers when you need recoverable lifecycle state
- React hooks such as `useSend()` and `useReceive()` remain the ergonomic React
  surface, but they now sit on top of the same operation-based workflows

## Existing wallet data and migrations

For the maintained adapters, keep using the same repository/database location
and initialize Coco normally.

```ts
const repo = new IndexedDbRepositories({ name: 'coco' });
const manager = await initializeCoco({ repo, seedGetter });
```

On startup:

- repository initialization runs schema setup or migrations through the adapter
- `initializeCoco()` reconciles legacy mint quote rows into mint operations
  before watchers, processors, or mint recovery start

That means alpha users should generally migrate by opening the same persisted
data with the new package names rather than exporting and re-importing wallet
state manually.

## CI, scripts, and workspace filters

If your scripts referenced the old package names, update them too.

```sh
# before
bun run --filter='coco-cashu-core' build

# after
bun run --filter='@cashu/coco-core' build
```

Do the same for any:

- Bun workspace filters
- test scripts
- release scripts
- docs snippets
- monorepo automation

## Release history and versions

The old alpha release history was archived under the repository's `history/`
directory. The `@cashu/*` packages start a new release line, so do not assume
that the latest alpha version number directly maps to the current namespaced
version number.

Upgrade by package name and API surface, not by comparing the old and new
version strings.

## Migration checklist

- Replace all `coco-cashu-*` dependencies with `@cashu/*`
- Rewrite imports to the new namespace
- For Node, switch from `sqlite3` to `better-sqlite3`
- Reinstall dependencies and regenerate the lockfile
- Update Bun workspace filters and CI scripts
- Prefer `manager.ops.*` for send, receive, mint, and melt flows
- Start the app against your existing persisted data and verify balances,
  pending operations, and mint subscriptions
