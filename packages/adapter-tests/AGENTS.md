# AGENTS
Package-specific guidance for `packages/adapter-tests`. Follow the repo-root `AGENTS.md` first; this file only adds adapter-test-specific rules.
## Scope
- This package defines reusable contract helpers for storage adapter packages.
- It should stay runner-agnostic and adapter-agnostic.
- Treat `src/index.ts` and `src/integration.ts` as the public API for adapter authors.
## Commands
- Build: `bun run --filter='coco-cashu-adapter-tests' build`
- Typecheck: `bun run --filter='coco-cashu-adapter-tests' typecheck`
- There is no package-local test script; validate changes through consuming adapter packages.
- Typical validation targets are `packages/sqlite3`, `packages/sqlite-bun`, `packages/indexeddb`, and `packages/expo-sqlite`.
- Real mint integration helper for adapters: `./scripts/test-integration.sh all` or `./scripts/test-integration.sh expo-sqlite`
## Contract design rules
- Prefer small, explicit helper APIs over clever abstractions.
- Keep the runner interface minimal so Bun and Vitest adapters can both consume it.
- Avoid assumptions about adapter internals; assert only behavior promised by `coco-cashu-core` repository interfaces.
- Any contract change here can force work in every adapter package, so keep backwards compatibility in mind.
## Test helper expectations
- `createRepositories()` should return a fresh isolated repository set for each test.
- Always require a `dispose()` cleanup path and keep examples aligned with that lifecycle.
- Contract tests should verify commit/rollback semantics and other behavior shared by all adapters.
- Integration helpers should work with externally provided `mintUrl` and optional logging without package-specific branching.
## Exports and docs
- Re-export new helpers from `src/index.ts` when they are meant for adapter packages.
- Do not expose half-finished migration helpers or experimental APIs from the package root.
- Keep README examples current when changing helper signatures or expected setup.
