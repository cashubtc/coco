# AGENTS

Guidance for agentic coding in this repo.

## AI-assisted workflow
- We typically create a git worktree per feature.
- If you are in a feature worktree, the project root is the worktree root (paths may differ).
- When planning in a feature worktree, use `FEATURE_TODO.md` in the worktree root to track plan and progress. If you are building and this file is present, check whether it should be updated.

## Repository layout
- packages/core: core TS library (services, models, repositories, tests).
- packages/react: React hooks/providers for core (Vite build, ESLint).
- packages/sqlite3: SQLite3 adapter (bun tests).
- packages/indexeddb: IndexedDB adapter (bun + vitest browser tests).
- packages/expo-sqlite: Expo SQLite adapter.
- packages/adapter-tests: contract test helpers.
- packages/docs: VitePress docs site.

## Core package layout
- `api/` exposes public API wrappers.
- `services/` holds business logic and orchestration.
- `operations/` implements send/melt flows.
- `infra/` contains transport/request helpers and subscriptions.
- `repositories/` defines interfaces and memory adapters.
- `models/` and `types.ts` hold domain types/errors.

## Tooling
- Use Bun workspaces; root scripts call `bun run --filter='pkg' ...`.
- `tsdown` builds most packages (ESM + CJS).
- React package builds with `tsc -b` + `vite`.
- Docs use VitePress.
- No root ESLint config; only React package is linted.

## Install
- `bun install`

## Build
- All packages: `bun run build`
- Core: `bun run --filter='coco-cashu-core' build`
- Adapter tests: `bun run --filter='coco-cashu-adapter-tests' build`
- IndexedDB: `bun run --filter='coco-cashu-indexeddb' build`
- Expo SQLite: `bun run --filter='coco-cashu-expo-sqlite' build`
- SQLite3: `bun run --filter='coco-cashu-sqlite3' build`
- React: `bun run --filter='coco-cashu-react' build`
- Docs: `bun run docs:build`

## Typecheck
- All packages: `bun run typecheck`
- Core: `bun run --filter='coco-cashu-core' typecheck`
- IndexedDB: `bun run --filter='coco-cashu-indexeddb' typecheck`
- Expo SQLite: `bun run --filter='coco-cashu-expo-sqlite' typecheck`
- SQLite3: `bun run --filter='coco-cashu-sqlite3' typecheck`
- React (project refs): `bun run --filter='coco-cashu-react' typecheck`

## Lint
- React only: `bun run --filter='coco-cashu-react' lint`

## Test
- Core all tests: `bun run --filter='coco-cashu-core' test`
- Core unit: `bun run --filter='coco-cashu-core' test:unit`
- Core integration: `bun run --filter='coco-cashu-core' test:integration`
- SQLite3 adapter: `bun run --filter='coco-cashu-sqlite3' test`
- IndexedDB adapter: `bun run --filter='coco-cashu-indexeddb' test`
- IndexedDB browser tests: `bun run --filter='coco-cashu-indexeddb' test:browser`
- Expo SQLite tests (no script): `bun --cwd packages/expo-sqlite test`
- React package has no tests yet.

## Run a single test
- Bun file: `bun run --filter='coco-cashu-core' test -- test/unit/Manager.test.ts`
- Bun by name: `bun run --filter='coco-cashu-core' test -- -t "initializeCoco" test/unit/Manager.test.ts`
- SQLite3 file: `bun run --filter='coco-cashu-sqlite3' test -- src/test/integration.test.ts`
- IndexedDB file: `bun run --filter='coco-cashu-indexeddb' test -- src/test/integration.test.ts`
- Vitest browser file: `bun run --filter='coco-cashu-indexeddb' test:browser -- src/test/integration.test.ts`
- Run all browsers locally: `CI=1 bun run --filter='coco-cashu-indexeddb' test:browser`

## Docs
- Dev server: `bun run docs:dev`
- Preview build: `bun run docs:preview`
- Package-local: `bun --cwd packages/docs run docs:dev`

## Formatting
- Prettier config in `.prettierrc`: single quotes, 100 char width, trailing commas.
- Indentation is 2 spaces, no tabs.
- Use semicolons (matches existing files).
- Keep lines <= 100 chars where practical.

## TypeScript and modules
- Packages are ESM (`"type": "module"`); use `import`/`export`.
- `moduleResolution: "bundler"` and `verbatimModuleSyntax` are on.
- Use `import type` for type-only imports.
- `allowImportingTsExtensions` is enabled; keep `.ts` extensions on local imports where used.
- `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride` are enabled.
- React package also enables `noUnusedLocals`/`noUnusedParameters`; core adapters do not.
- Avoid `any`; if required, keep it localized and add an eslint disable comment only if needed.

## Imports
- Order: external first, then internal/alias, then relative.
- Prefer named exports; default exports are rare (React hooks may default-export).
- Use path aliases in core (`@core/*`) when already established.
- Keep import ordering consistent within a file; don't churn order without reason.

## Naming
- Classes and types: `PascalCase`.
- Functions/variables: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` when truly constant.
- Repositories are `XxxRepository` implementations (e.g., `SqliteProofRepository`).
- React hooks: `useX` and file names `useX.ts`.
- React components: `PascalCase` file names matching component names.
- Test files: `*.test.ts` under `test/unit` or `test/integration`.

## Error handling
- Validate inputs early; return empty arrays for no-op cases (common pattern).
- Prefer domain errors in `packages/core/models/Error.ts` for protocol/state failures.
- Include `cause` when wrapping errors; preserve original error objects.
- Log with context: `logger?.info('message', { mintUrl, ... })`.
- Avoid swallowing exceptions; either handle and log or rethrow.

## Logging and events
- Use structured logging across services (`debug/info/warn/error`).
- Emit `EventBus` events when state changes in core services.
- Avoid emitting events from adapters unless that interface requires it.

## Data and repositories
- Repositories are transactional; keep operations atomic.
- Pre-check invariants (existence, state, reservation) before mutating.
- Serialize JSON fields consistently and defensively parse.
- Normalize mint URLs with `normalizeMintUrl()` before persistence.

## Exports and barrels
- Public exports go through each package's `index.ts`.
- Update `index.ts` when adding new public types/services.
- Keep adapter packages exporting repository classes from `src/index.ts`.
- Avoid exporting internal helpers from package roots.

## Comments and docs
- Use JSDoc on public APIs and non-obvious flows.
- Keep section dividers and headings consistent with existing style.
- Avoid inline comments for trivial code.

## React package specifics
- ESLint config: `packages/react/eslint.config.js`.
- Keep hooks rules clean (`react-hooks`).
- Use `useCallback`/`useMemo` when a value is referenced in deps arrays.
- When catching unknown errors in hooks, normalize via `e instanceof Error ? e : new Error(String(e))`.

## Testing notes
- Use `bun:test` (`describe`, `it`, `expect`, `mock`).
- Prefer Bun `mock()` for test doubles and spies.
- Assert mock usage with `toHaveBeenCalled*` or `mock.calls` instead of manual counters.
- Keep async tests `async` and `await` promises; avoid racey timers unless needed.
- Browser tests run via Playwright in Vitest; see `packages/indexeddb/vitest.config.ts`.

## Build outputs
- Build artifacts live in `dist/`; do not edit generated files.
- `tsdown` builds ESM and CJS; keep entry points in `index.ts`.

## Cursor/Copilot rules
- No `.cursor/rules`, `.cursorrules`, or `.github/copilot-instructions.md` found.
