# AGENTS

## Purpose
- Guidance for agentic coding in this repo.
- Keep commands and conventions in sync with scripts and CI.
- Prefer minimal, focused edits that match existing patterns.

## Repo layout
- Monorepo managed by Bun workspaces (`packages/*`).
- Core library: `packages/core` (services, repositories, tests).
- Adapters: `packages/sqlite3`, `packages/indexeddb`, `packages/expo-sqlite`.
- React wrapper: `packages/react`.
- Adapter test helpers: `packages/adapter-tests`.
- Docs: `packages/docs` (VitePress).

## Tooling
- Package manager: Bun (CI uses bun 1.2.18).
- Build tools: tsdown (libraries), Vite (React), VitePress (docs).
- Language: TypeScript, ESM (`"type": "module"` in packages).
- Tests: bun:test for Node, Vitest + Playwright for browser tests.

## Install
- `bun install --frozen-lockfile` (CI default).
- `bun install` (local).

## Build commands
- Root build all packages: `bun run build`.
- Core only: `bun run --filter='coco-cashu-core' build` or `bun run build` in `packages/core`.
- Adapters: run `bun run build` in each adapter package.
- React: `bun run build` in `packages/react`.
- Docs: `bun run docs:build` (root) or in `packages/docs`.

## Typecheck commands
- All packages in dependency order: `bun run typecheck` (root).
- Per package: `bun run typecheck` inside the package dir.
- React uses project refs: `tsc -b --noEmit` via `bun run typecheck`.

## Lint commands
- Lint exists in `packages/react` only.
- Run: `bun run lint` in `packages/react`.
- ESLint config: `packages/react/eslint.config.js`.

## Test commands
- Core unit tests: `bun run test:unit` in `packages/core`.
- Core integration tests: `bun run test:integration` in `packages/core`.
- Full core suite: `bun run test` in `packages/core`.
- IndexedDB tests: `bun run test` (Bun) or `bun run test:browser` (Vitest + Playwright).
- SQLite3 tests: `bun run test` in `packages/sqlite3`.
- Expo SQLite tests: see `packages/expo-sqlite/src/test` and integration script.

## Run a single test
- Bun single file: `bun test test/unit/Manager.test.ts` (from `packages/core`).
- Bun name filter: `bun test -t "should recover" test/unit/Manager.test.ts`.
- Bun integration file: `bun test test/integration/integration.test.ts`.
- Browser test by name: `bun run test:browser -- --testNamePattern="melt quote"`.

## Integration test harness (Docker mint)
- Script: `./scripts/test-integration.sh`.
- List suites: `./scripts/test-integration.sh list`.
- Run one package: `./scripts/test-integration.sh sqlite3`.
- Filter by test name: `./scripts/test-integration.sh sqlite3 -t "melt quote"`.
- Log level: `./scripts/test-integration.sh core -l debug`.
- Requires Docker + curl; runs `cashubtc/mintd:0.13` containers per suite.
- Script builds `packages/adapter-tests` and `packages/core` before tests.

## Docs commands
- Dev server: `bun run docs:dev` (root or `packages/docs`).
- Build: `bun run docs:build`.
- Preview: `bun run docs:preview`.

## Code style and conventions
- Follow `.prettierrc`: single quotes, print width 100, trailing commas.
- Use spaces (no tabs).
- Prefer ESM import/export, no `require`.
- Use `import type` for type-only imports (`verbatimModuleSyntax` is enabled).
- Keep imports grouped: external first, then local modules, then types if separated.
- Preserve the file's import ordering and extension style (`.ts` vs none).
- Favor named exports and barrel `index.ts` re-exports.
- Keep public API exports in package `index.ts` consistent.

- TypeScript strict mode is on across packages (`strict: true`).
- `noUncheckedIndexedAccess` and `noImplicitOverride` are enabled.
- Most packages allow unused locals/params; React enforces them.
- `moduleResolution: bundler` and `allowImportingTsExtensions` are enabled.
- Prefer explicit return types for exported functions and public APIs.
- Use `readonly` for class fields that are not reassigned.
- Prefer `const` and narrow scopes for `let`.
- Use `as const` for literal config objects when needed.

## Naming and structure
- Classes, types, interfaces: `PascalCase`.
- Functions, variables, methods: `camelCase`.
- Files: `PascalCase.ts` for classes/services; lowercase folders.
- Tests: `*.test.ts` under `test/unit`, `test/integration`, or `src/test`.
- Use descriptive test names; keep suites focused.

## Error handling and logging
- Prefer domain error classes in `packages/core/models/Error.ts`.
- Attach context and preserve `cause` where possible.
- Log with injected `Logger` (`logger?.info/warn/error`) over `console`.
- Use child loggers via `logger.child({ module })` when available.
- Avoid swallowing errors; log and rethrow when recovery is not possible.
- For async workflows with locks, use `try/finally` to release resources.
- Event bus error handling is centralized; prefer events over ad-hoc throwing.

## Testing conventions
- Bun test runner is the default for Node packages.
- Browser tests use Vitest + Playwright (IndexedDB) and are headless by default.
- Keep unit tests fast and isolated; integration tests can use Docker mint.
- Prefer Bun `mock()` for test doubles and spies.
- Assert mock usage with `toHaveBeenCalled*` or `mock.calls` instead of counters.

## React package specifics
- ESLint config: `packages/react/eslint.config.js`.
- Uses `@eslint/js`, `typescript-eslint`, `react-hooks`, and `react-refresh`.
- TypeScript project refs: `tsconfig.app.json` and `tsconfig.node.json`.
- `noUnusedLocals` and `noUnusedParameters` are enabled in React configs.

## Release/versioning
- Changesets are used (`.changeset/`); keep entries small and focused.
- Package versions use pre-release tags (e.g., `1.1.2-rc.42`).

## CI notes
- CI uses Bun 1.2.18 and `bun install --frozen-lockfile`.
- Build order: core -> adapter-tests -> adapters -> react.
- Core unit tests run `bun run test:unit` in `packages/core`.
- Integration workflows run `./scripts/test-integration.sh <package>`.

## Cursor/Copilot instructions
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.

## When editing
- Avoid reformatting unrelated code.
- Keep public APIs stable; update docs/tests when signatures change.
- Prefer small, focused changes over large refactors.
- Ensure tests and typecheck commands pass for touched packages.

## Quick command cheatsheet
- `bun run build`
- `bun run typecheck`
- `cd packages/core && bun run test:unit`
- `cd packages/core && bun test -t "pattern" test/unit/Manager.test.ts`
- `./scripts/test-integration.sh list`
- `./scripts/test-integration.sh sqlite3 -t "pattern"`
- `cd packages/react && bun run lint`
- `bun run docs:dev`
- `bun run docs:build`
- `bun run docs:preview`
