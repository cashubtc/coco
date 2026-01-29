# Contributing

Thanks for helping improve coco-cashu. This is alpha software and the API can change,
so favor clear changes and strong tests.

## Repository layout

- packages/core: storage-agnostic core, services, event bus, repositories.
- packages/react: React hooks/providers wrapper.
- packages/sqlite3: SQLite3 adapter for Node.
- packages/indexeddb: IndexedDB adapter for web.
- packages/expo-sqlite: Expo SQLite adapter for React Native.
- packages/adapter-tests: contract test helpers for adapters.
- packages/docs: VitePress docs site.
- packages/demo-cli: Node CLI demo using SQLite3.
- packages/demo-web: Vite web demo using IndexedDB.

## Development setup

- Install deps: `bun install`
- Tooling: Bun workspaces, tsdown builds most packages, React uses tsc + Vite.

## Common commands

```sh
bun run build
bun run typecheck
bun run --filter='coco-cashu-core' test
bun run --filter='coco-cashu-react' lint
bun run docs:dev
```

## Git workflow defaults

- Use a feature branch or worktree per change set.
- Write meaningful commits that explain intent, not just file edits.
- Use Conventional Commits with optional scope (e.g. `feat(core): add token encoding`).
  Common types include `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
  `chore`, and `project` for repo-level updates.
- Use Changesets for versioned package changes when relevant.
- Avoid WIP commits; use `git commit --amend` to refine the latest commit.
- Squash fixups before merging so the history tells a clear story.

## Coding standards

- Formatting: Prettier in `.prettierrc`, 2 spaces, semicolons, <= 100 chars.
- TypeScript: ESM, `moduleResolution: bundler`, use `import type` for types.
- Imports: external then internal/alias then relative; avoid churn.
- Naming: PascalCase types/classes, camelCase vars/functions, useX hooks.
- Comments: JSDoc on public APIs and non-obvious flows.

## Core and adapter rules

- Validate inputs early; return empty arrays for no-op cases.
- Prefer domain errors in `packages/core/models/Error.ts`.
- Include `cause` when wrapping errors; avoid swallowing exceptions.
- Structured logging with context; emit EventBus events on core state changes.
- Repositories are transactional; pre-check invariants before mutating.
- Normalize mint URLs with `normalizeMintUrl()` before persistence.
- Public exports go through each package `index.ts`.

## Testing

- Use `bun:test` (`describe`, `it`, `expect`, `mock`).
- Keep tests in `test/unit` or `test/integration` and name `*.test.ts`.

## React package specifics

- ESLint config: `packages/react/eslint.config.js`.
- Keep hook deps correct; use `useCallback` or `useMemo` as needed.
- Normalize unknown errors in hooks: `e instanceof Error ? e : new Error(String(e))`.

## Docs

- VitePress docs live in `packages/docs`.
- Dev server: `bun run docs:dev`.

## AI-assisted workflow

- We typically create a git worktree per feature.
- If you are in a feature worktree, the project root is the worktree root.
- When planning in a feature worktree, use `FEATURE_TODO.md` in the root to
  track plan and progress. If you are building and this file is present, check
  whether it should be updated.
