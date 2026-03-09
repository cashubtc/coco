# AGENTS
Package-specific guidance for `packages/core`. Follow the repo-root `AGENTS.md` first; this file only adds core-specific rules.
## Scope
- `packages/core` is the main orchestration layer for the library.
- Key areas are `api/`, `services/`, `operations/`, `infra/`, `repositories/`, `events/`, `plugins/`, and `test/`.
- Treat `Manager.ts` as the main wiring point; changes there can affect most public behavior.
## Commands
- Build: `bun run --filter='coco-cashu-core' build`
- Typecheck: `bun run --filter='coco-cashu-core' typecheck`
- All tests: `bun run --filter='coco-cashu-core' test`
- Unit tests: `bun run --filter='coco-cashu-core' test:unit`
- Integration tests: `bun run --filter='coco-cashu-core' test:integration`
- Single file: `bun run --filter='coco-cashu-core' test -- test/unit/Manager.test.ts`
- Single test by name: `bun run --filter='coco-cashu-core' test -- -t "initializeCoco" test/unit/Manager.test.ts`
- Real mint integration helper: `./scripts/test-integration.sh core`
## Architecture rules
- Preserve the split between high-level APIs, services, and saga-like operations.
- Keep crash recovery and rollback behavior intact for send, receive, and melt flows.
- When changing operation states, update persistence, recovery logic, emitted events, and tests together.
- Keep watcher and processor behavior opt-in/out through `initializeCoco()` and `Manager` configuration.
- Plugins should flow through `plugins/types.ts`, `PluginHost.ts`, and `manager.ext`; avoid ad hoc extension points.
## Repositories and data
- Repository interfaces in `repositories/index.ts` are the contract for every adapter; change them carefully.
- Memory repositories are the reference behavior for adapters and tests; keep them aligned with interface changes.
- Normalize mint URLs before lookup or persistence.
- Preserve reservation semantics like `usedByOperationId`, `createdByOperationId`, and proof state invariants.
- Prefer atomic repository operations and explicit pre-checks before mutation.
## Public API surface
- Any intentionally public type or class should be exported through the relevant local `index.ts` and then `packages/core/index.ts`.
- Avoid leaking internal helpers from package roots unless the API is deliberate and documented.
- Keep JSDoc strong on public entry points such as `initializeCoco`, APIs, and plugin-facing types.
## Tests
- Prefer focused unit tests under `test/unit` for service or operation changes.
- Add or update integration tests when behavior crosses repositories, watchers, subscriptions, or real mint flows.
- When touching recovery logic, add assertions for restart/retry/rollback paths, not only the happy path.
