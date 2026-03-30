# Contributing to coco

We want to make it easy to contribute to coco.

The kinds of changes that are usually a good fit:

- Bug fixes
- Adapter improvements
- Better tests and reproducible fixtures
- Type safety or API ergonomics improvements
- Documentation updates and examples
- Performance or reliability fixes

If you want to add a new public API, change protocol behavior, or introduce a new
package, please start with an issue or design discussion first. Small fixes can go
straight to a pull request.

If you are unsure whether a change is in scope, open an issue with the problem you
want to solve and the approach you have in mind.

## Developing coco

- Requirements: Bun (CI currently runs Bun 1.2.18)
- Install dependencies from the repo root:

  ```bash
  bun install
  ```

- If you plan to run IndexedDB browser tests locally, install Playwright browsers:

  ```bash
  bunx playwright install
  ```

### Repository map

- `packages/core` - storage-agnostic core library, services, operations, models,
  repositories, and tests
- `packages/react` - React hooks and providers for the core package
- `packages/adapter-tests` - shared contract test helpers for storage adapters
- `packages/indexeddb` - IndexedDB adapter for web environments
- `packages/expo-sqlite` - Expo SQLite adapter for React Native and Expo apps
- `packages/sqlite3` - `better-sqlite3` adapter for Node.js
- `packages/sqlite-bun` - Bun SQLite adapter
- `packages/docs` - VitePress documentation site

### Common commands

From the repository root:

```bash
bun install
bun run build
bun run typecheck
bun run docs:dev
bun run docs:build
```

Useful package-level commands:

```bash
bun run --filter='@cashu/coco-core' test
bun run --filter='@cashu/coco-core' test:unit
bun run --filter='@cashu/coco-core' test:integration
bun run --filter='@cashu/coco-react' lint
bun run --filter='@cashu/coco-indexeddb' test
bun run --filter='@cashu/coco-indexeddb' test:browser
bun run --filter='@cashu/coco-sqlite' test
bun run --filter='@cashu/coco-sqlite-bun' test
bun --cwd packages/expo-sqlite test
```

Run the smallest relevant test set for your change. If you touch shared logic,
running `bun run build`, `bun run typecheck`, and the affected package tests is a
good default.

### Running a single test

```bash
bun run --filter='@cashu/coco-core' test -- test/unit/Manager.test.ts
bun run --filter='@cashu/coco-core' test -- -t "initializeCoco" test/unit/Manager.test.ts
bun run --filter='@cashu/coco-sqlite' test -- src/test/integration.test.ts
bun run --filter='@cashu/coco-indexeddb' test -- src/test/integration.test.ts
bun run --filter='@cashu/coco-indexeddb' test:browser -- src/test/integration.test.ts
```

## Workflow expectations

### Start small and stay focused

- Keep pull requests narrow and easy to review
- Prefer one logical change per PR
- Update docs when public behavior changes
- Do not edit generated `dist/` output

### Issue first for larger changes

Please open an issue before spending time on:

- new packages or adapters
- significant public API changes
- protocol behavior changes
- large refactors

This helps us agree on direction before implementation.

### Worktrees and planning

We often use a git worktree per feature. If you are working from a feature
worktree and there is a `FEATURE_TODO.md` file at the root, keep it updated as you
work.

## Pull request expectations

- Explain the problem and why your change is the right fix
- Include the verification steps you ran
- Keep descriptions short and concrete
- Add screenshots when a PR changes UI or docs visuals
- Mention follow-up work instead of bundling unrelated fixes into the same PR

If your change affects a published package, add a changeset:

```bash
bunx changeset
```

Use concise, conventional commit-style titles, and prefer adding a scope when the
affected package or area is clear:

- `feat:` new functionality
- `fix:` bug fixes
- `docs:` documentation changes
- `refactor:` code cleanup without behavior changes
- `test:` test changes
- `chore:` maintenance work

We commonly use scoped messages such as:

- `fix(core): prevent duplicate quote sync`
- `feat(react): add wallet provider reset hook`
- `docs(docs): clarify adapter setup`

If a change spans the whole repository rather than one package, an unscoped title
like `chore: update release workflow` is fine.

## Style guide

Please follow the project guidance in `AGENTS.md`. The short version:

- Use TypeScript with ESM `import` and `export`
- Prefer `import type` for type-only imports
- Keep formatting aligned with `.prettierrc`: 2 spaces, semicolons, 100-column lines
- Order imports as external, then internal or alias, then relative
- Use `PascalCase` for classes and types, `camelCase` for values and functions
- Avoid `any` unless it is tightly scoped and justified
- Add JSDoc for public APIs and non-obvious flows

### Core and adapter conventions

- Validate inputs early and return empty arrays for no-op cases when appropriate
- Prefer domain errors from `packages/core/models/Error.ts`
- Preserve error causes when wrapping failures
- Use structured logging with context
- Keep repository operations atomic and check invariants before mutating state
- Normalize mint URLs with `normalizeMintUrl()` before persistence
- Export public package APIs through each package `index.ts`

### React package conventions

- Keep hook dependency arrays correct
- Use `useCallback` or `useMemo` when a value participates in dependencies
- Normalize unknown caught errors with
  `e instanceof Error ? e : new Error(String(e))`

## Testing expectations

We use `bun:test` across most packages, plus Vitest for some adapter coverage.

- Put tests under `test/unit` or `test/integration`
- Name test files `*.test.ts`
- Prefer Bun `mock()` for spies and doubles
- Keep tests deterministic and await async work explicitly
- Add or update tests with behavior changes whenever practical

For browser coverage in `packages/indexeddb`, run:

```bash
CI=1 bun run --filter='@cashu/coco-indexeddb' test:browser
```

## Releases and versioning

Published packages are versioned with Changesets. If your PR changes runtime
behavior, public types, package exports, or documentation for a published package,
you should usually include a changeset unless a maintainer tells you otherwise.

## Good contributions

The fastest way to get a PR reviewed is to keep it easy to understand:

- describe the user-visible problem
- keep the implementation straightforward
- show how you verified the change
- avoid unrelated cleanup in the same PR

Thanks for contributing.
