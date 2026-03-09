# AGENTS
Guidance for agentic coding in this repository.
## AI-assisted workflow
- We typically create a git worktree per feature.
- If you are in a feature worktree, treat that worktree root as the project root.
- If `FEATURE_TODO.md` exists in the current worktree, keep it updated as you plan and implement.
- Before editing, check for unrelated local changes and avoid reverting user work.
## Repository layout
- `packages/core`: core TypeScript library with services, operations, repositories, models, and tests.
- `packages/react`: React hooks and providers around the core package.
- `packages/sqlite3`: Node SQLite adapter built on `better-sqlite3`.
- `packages/sqlite-bun`: Bun SQLite adapter built on `bun:sqlite`.
- `packages/indexeddb`: IndexedDB adapter with Bun tests and Vitest browser tests.
- `packages/expo-sqlite`: Expo SQLite adapter.
- `packages/adapter-tests`: shared adapter contract helpers.
- `packages/docs`: VitePress documentation site.
## Core package layout
- `api/`: public API wrappers.
- `services/`: business logic and orchestration.
- `operations/`: send, receive, and melt flows.
- `infra/`: request helpers, transports, subscriptions, websocket plumbing.
- `repositories/`: repository interfaces and memory implementations.
- `events/`: typed event bus and event definitions.
- `models/` and `types.ts`: domain models, error types, shared types.
- `plugins/`: plugin extension points and related types.
## Agent rule files
- Existing agent guidance lives in `/home/egge/projects/coco-cashu/AGENTS.md`.
- Package-specific guides also exist in `packages/core/AGENTS.md`, `packages/adapter-tests/AGENTS.md`, and `packages/react/AGENTS.md`.
- No `.cursor/rules/` directory was found.
- No `.cursorrules` file was found.
- No `.github/copilot-instructions.md` file was found.
## Tooling
- Use Bun workspaces from the repo root.
- Most packages build with `tsdown` and output ESM plus CJS artifacts in `dist/`.
- The React package builds with `tsc -b` plus `vite build` and is the only package with ESLint.
- The docs site uses VitePress.
## Install
- `bun install`
## Build
- All library packages: `bun run build`
- Core: `bun run --filter='coco-cashu-core' build`
- Adapter tests: `bun run --filter='coco-cashu-adapter-tests' build`
- IndexedDB: `bun run --filter='coco-cashu-indexeddb' build`
- Expo SQLite: `bun run --filter='coco-cashu-expo-sqlite' build`
- SQLite3: `bun run --filter='coco-cashu-sqlite3' build`
- SQLite Bun: `bun run --filter='coco-cashu-sqlite-bun' build`
- React: `bun run --filter='coco-cashu-react' build`
- Docs site: `bun run docs:build`
- Package-local docs build: `bun --cwd packages/docs run docs:build`
## Typecheck
- All packages: `bun run typecheck`
- Core: `bun run --filter='coco-cashu-core' typecheck`
- Adapter tests: `bun run --filter='coco-cashu-adapter-tests' typecheck`
- IndexedDB: `bun run --filter='coco-cashu-indexeddb' typecheck`
- Expo SQLite: `bun run --filter='coco-cashu-expo-sqlite' typecheck`
- SQLite3: `bun run --filter='coco-cashu-sqlite3' typecheck`
- SQLite Bun: `bun run --filter='coco-cashu-sqlite-bun' typecheck`
- React: `bun run --filter='coco-cashu-react' typecheck`
## Lint
- React only: `bun run --filter='coco-cashu-react' lint`
- There is no root ESLint config for the rest of the monorepo.
## Test
- Core all tests: `bun run --filter='coco-cashu-core' test`
- Core unit: `bun run --filter='coco-cashu-core' test:unit`
- Core integration: `bun run --filter='coco-cashu-core' test:integration`
- SQLite3 adapter: `bun run --filter='coco-cashu-sqlite3' test`
- SQLite Bun adapter: `bun run --filter='coco-cashu-sqlite-bun' test`
- IndexedDB adapter: `bun run --filter='coco-cashu-indexeddb' test`
- IndexedDB browser tests: `bun run --filter='coco-cashu-indexeddb' test:browser`
- Expo SQLite adapter: `bun run --filter='coco-cashu-expo-sqlite' test`
- React package currently has no tests.
## Run a single test
- Core by file: `bun run --filter='coco-cashu-core' test -- test/unit/Manager.test.ts`
- Core by name: `bun run --filter='coco-cashu-core' test -- -t "initializeCoco" test/unit/Manager.test.ts`
- Core integration file: `bun run --filter='coco-cashu-core' test -- test/integration/integration.test.ts`
- SQLite3 by file: `bun run --filter='coco-cashu-sqlite3' test -- src/test/integration.test.ts`
- SQLite3 by name: `bun run --filter='coco-cashu-sqlite3' test -- -t "contract" src/test/contract.test.ts`
- SQLite Bun by file: `bun run --filter='coco-cashu-sqlite-bun' test -- src/test/integration.test.ts`
- Expo SQLite by file: `bun run --filter='coco-cashu-expo-sqlite' test -- src/test/integration.test.ts`
- IndexedDB by file: `bun run --filter='coco-cashu-indexeddb' test -- src/test/integration.test.ts`
- IndexedDB browser by file: `bun run --filter='coco-cashu-indexeddb' test:browser -- src/test/integration.test.ts`
- IndexedDB browser all local Chromium only: `bun run --filter='coco-cashu-indexeddb' test:browser`
- IndexedDB browser all CI browsers locally: `CI=1 bun run --filter='coco-cashu-indexeddb' test:browser`
## Integration test helper script
- Use `scripts/test-integration.sh` to run package integration tests against a real local `mintd` Docker container.
- All suites: `./scripts/test-integration.sh` or `./scripts/test-integration.sh all`
- Single package: `./scripts/test-integration.sh expo-sqlite`
- Filter by test name: `./scripts/test-integration.sh expo-sqlite -t 'melt quote'`
- Set log verbosity: `./scripts/test-integration.sh all -l info`
- The script requires `docker` and `curl`, builds required packages up front, and installs Playwright browsers when browser-based integration tests are included.
## Docs
- Root dev server: `bun run docs:dev`
- Root preview build: `bun run docs:preview`
- Package-local dev server: `bun --cwd packages/docs run docs:dev`
## Formatting
- Prettier config is in `.prettierrc`.
- Use spaces, not tabs, with 2-space indentation.
- Use single quotes and trailing commas where allowed.
- Keep lines near 100 characters and follow existing semicolon usage.
## TypeScript and modules
- Packages are ESM (`"type": "module"`).
- Use `import` and `export`, not CommonJS.
- `moduleResolution: "bundler"`, `verbatimModuleSyntax`, and `allowImportingTsExtensions` are enabled.
- Preserve existing local `.ts` import style.
- `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride` are enabled broadly.
- Adapter packages usually leave unused checks off; React enables stricter unused checks.
- Avoid `any`; if unavoidable, keep it narrow and local.
## Imports
- Order imports as external packages, then internal aliases, then relative imports.
- Use `import type` for type-only imports.
- In `packages/core`, prefer `@core/*` aliases when that pattern is already in use.
- Keep import ordering stable and prefer named exports; default exports are uncommon outside some React hooks and config files.
## Public exports and barrels
- Public API surfaces should flow through each package `index.ts`.
- Update the relevant `index.ts` when adding a new public service, model, type, or repository.
- Do not expose internal helpers from package roots unless they are intentionally public.
## Naming conventions
- Classes, interfaces, and types use `PascalCase`.
- Functions, methods, variables, and instances use `camelCase`.
- Constants use `SCREAMING_SNAKE_CASE` only when they are truly constant.
- Repository implementations are named `XxxRepository` such as `SqliteProofRepository`.
- React hooks use `useX`, components use matching `PascalCase` file names, and tests use `*.test.ts`.
## Error handling
- Validate inputs early.
- For list-based no-op operations, returning `[]` or exiting early is common.
- Prefer domain-specific errors from `packages/core/models/Error.ts` for protocol or state failures.
- When wrapping errors, preserve the original error with `cause`.
- In React hooks, normalize unknown catches with `e instanceof Error ? e : new Error(String(e))`.
- Do not swallow exceptions silently; either handle and log them or rethrow.
## Logging and events
- Use structured logging with contextual objects.
- Preferred levels are `debug`, `info`, `warn`, and `error`.
- Typical pattern: `logger?.info('message', { mintUrl, ... })`.
- Emit `EventBus` events when core service state changes; avoid emitting from adapters unless required.
## Data and repositories
- Repository operations should be atomic and transactional.
- Pre-check invariants before mutation, especially existence, readiness, and reservation state.
- Normalize mint URLs with `normalizeMintUrl()` before persistence and lookup.
- Serialize JSON fields consistently and parse them defensively on read.
- Preserve operation IDs and state transitions carefully in repository code.
## Comments and docs
- Add JSDoc on public APIs and non-obvious flows.
- Keep comments focused on intent, invariants, or tricky behavior.
- Avoid redundant inline comments that restate the code.
## React package specifics
- ESLint config lives at `packages/react/eslint.config.js`.
- Keep `react-hooks` rules clean.
- Use `useCallback` or `useMemo` when values participate in dependency arrays.
- Preserve the existing hook-first API style in `packages/react/src/lib/hooks`.
## Testing notes
- Core and several adapters use `bun:test` with `describe`, `it`, `expect`, and `mock`.
- `packages/sqlite3` uses Vitest for Node tests.
- `packages/indexeddb` browser tests use Vitest Browser Mode with Playwright.
- Prefer Bun `mock()` for spies and doubles where Bun tests are already in use.
- Assert mock behavior with `toHaveBeenCalled*` or `mock.calls` instead of manual counters.
- Keep async tests fully awaited; avoid race-prone timer logic unless necessary.
## Build outputs
- Generated artifacts live in `dist/`.
- Do not edit generated build output directly.
- Keep source entry points in `index.ts` files.
