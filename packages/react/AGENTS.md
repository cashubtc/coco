# AGENTS
Package-specific guidance for `packages/react`. Follow the repo-root `AGENTS.md` first; this file only adds React-package-specific rules.
## Scope
- This package wraps `coco-cashu-core` with React providers, contexts, and hooks.
- Source code lives under `src/lib`; `src/App.tsx` is only the local demo app.
- The public package surface should flow through `src/lib/index.ts` and then package exports.
## Commands
- Dev server: `bun run --filter='coco-cashu-react' dev`
- Build: `bun run --filter='coco-cashu-react' build`
- Typecheck: `bun run --filter='coco-cashu-react' typecheck`
- Lint: `bun run --filter='coco-cashu-react' lint`
- Preview demo app: `bun run --filter='coco-cashu-react' preview`
- There are currently no package tests, so rely on lint, typecheck, and careful manual verification.
## API shape
- Preserve the hook-first API style in `src/lib/hooks`.
- Keep provider composition simple; `CocoCashuProvider` should remain the main convenience wrapper.
- Context hooks should throw clear guidance when a provider is missing.
- Expose only stable library APIs from `src/lib`; avoid exporting demo-only components.
## React implementation rules
- Memoize provider values and callbacks when they participate in dependency arrays.
- Guard async state updates on unmount when a hook owns request lifecycle.
- Normalize unknown errors to `Error` objects before storing them in state or invoking callbacks.
- Follow the existing callback options pattern: `onSuccess`, `onError`, and `onSettled`.
- Prefer deriving view state from manager events rather than duplicating business logic in React.
## File organization
- Providers live in `src/lib/providers`, contexts in `src/lib/contexts`, hooks in `src/lib/hooks`.
- Keep named exports for providers and contexts; default exports are currently limited to some hooks.
- If a new hook or provider is public, update the relevant local barrel file immediately.
## Verification
- For changes that affect consumers, verify both the library build and the demo app behavior.
- Pay extra attention to `react-hooks` lint warnings, dependency arrays, and stale closure issues.
