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

- Requirements: Bun; use the version configured in the relevant [CI workflow](.github/workflows).
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
- `packages/fountain` - optional binary fountain transport, Cashu helpers, and UR decoding
- `packages/adapter-tests` - shared contract test helpers for storage adapters
- `packages/indexeddb` - IndexedDB adapter for web environments
- `packages/expo-sqlite` - Expo SQLite adapter for React Native and Expo apps
- `packages/sqlite3` - `better-sqlite3` adapter for Node.js
- `packages/sqlite-bun` - Bun SQLite adapter
- `packages/cocod` - Cashu wallet CLI and daemon built on the workspace packages (private,
  not published)
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
bun run --filter='@cashu/coco-fountain' test
bun run --filter='@cashu/coco-fountain' test:browser
bun run --filter='@cashu/coco-fountain' test:package
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

## Security fixes

When a task involves a vulnerability or an uncoordinated security fix, do not
describe the exploit in depth in anything public: PR titles or bodies, commit
messages, review comments, or code comments. Keep the public summary high-level
(state that a security issue was fixed) and leave out reproduction steps, proofs
of concept, root-cause specifics, and attack paths.

Until a fix has been released and disclosure has been coordinated, send the
detailed write-up to the security contact listed under
[Reporting a Vulnerability](SECURITY.md#reporting-a-vulnerability) in `SECURITY.md`.

## AI-assisted contributions

We encourage AI use and AI-assisted contributions, especially to improve code
quality, strengthen tests, and support code review.

A human must remain in the loop and take responsibility for every submission:

- Review and understand every change. Be prepared to explain the implementation
  and how it fits the existing code.
- Verify claims, run relevant checks, and report what you tested and any
  limitations.
- Review and edit AI-assisted PR descriptions, issues, discussions, and review
  comments before posting. Keep them concise, accurate, and relevant.
- Submit work that is ready for human review. Use AI to help with investigation
  and validation, and check its results before asking maintainers to review.

Do not use unattended AI agents to submit pull requests, issues, or comments
without human review. Automated spam and repeated low-effort submissions consume
maintainer time and may be closed or removed. Repeated disregard for these
expectations may lead to contribution restrictions.

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

Use the affected package's TypeScript configuration and [.prettierrc](.prettierrc) for compiler and
formatting settings. Additional syntax conventions:

- Use TypeScript with ESM `import` and `export`
- Prefer `import type` for type-only imports
- Order imports as external, then internal or alias, then relative
- Use `PascalCase` for classes and types, `camelCase` for values and functions

### Core and adapter conventions

Use [CODING_STANDARDS.md](CODING_STANDARDS.md) for validation, types, errors, logging, persistence,
public contracts and documentation expectations.

### React package conventions

- Keep hook dependency arrays correct
- Use `useCallback` or `useMemo` when a value participates in dependencies
- Normalize unknown caught errors with
  `e instanceof Error ? e : new Error(String(e))`

## Testing expectations

We use `bun:test` across most packages, plus Vitest for some adapter coverage.
Use the [behavior testing standards](CODING_STANDARDS.md#test-behavior) to choose meaningful coverage
and handle asynchronous behavior.

Run `bun run test:coverage:core` for core unit coverage. Core unit and integration coverage use
`scripts/scope-core-coverage.ts` to report only core source, excluding generated `dist/` output and
other workspace packages imported by the tests. Adapter behavior can still be exercised by core
tests; adapter coverage belongs in separate adapter reports.

- Put tests under `test/unit` or `test/integration`
- Name test files `*.test.ts`
- Prefer Bun `mock()` for spies and doubles

For browser coverage in `packages/indexeddb`, run:

```bash
CI=1 bun run --filter='@cashu/coco-indexeddb' test:browser
```

## Releases and versioning

Published packages are versioned with Changesets. If your PR changes runtime
behavior, public types, package exports, or documentation for a published package,
you should usually include a changeset unless a maintainer tells you otherwise.

Stable and prerelease npm publishes validate and publish the tagged commit.
Package versions and changelogs must be committed before the GitHub Release is
published. See `RELEASING.md` for the maintainer release checklist.

## Good contributions

The fastest way to get a PR reviewed is to keep it easy to understand:

- describe the user-visible problem
- keep the implementation straightforward
- show how you verified the change
- avoid unrelated cleanup in the same PR

Thanks for contributing.
