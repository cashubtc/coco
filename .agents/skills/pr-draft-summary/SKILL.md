---
name: pr-draft-summary
description: Create the repo-ready PR draft block, branch suggestion, Conventional Commit-style title, and concise PR description for cashubtc/coco after substantive code changes. Use in the final handoff for runtime, test, docs-with-impact, or build/config work; skip only for trivial or conversation-only tasks, repo-meta or docs-only changes without behavior impact, or when the user explicitly says not to include it.
---

# PR Draft Summary

## Purpose

Produce the PR-ready summary for `cashubtc/coco` after substantive work is complete:
a branch suggestion, a Conventional Commit-style PR title, and a concise PR
description aligned with `CONTRIBUTING.md`.

## When to Trigger

- The task is finished or ready for review and it touched runtime code, tests,
  docs with behavior impact, examples, or build/test/release configuration.
- Treat this as the default final handoff step for substantive code work. Run it
  after verification and after any needed changeset work.
- Skip only for trivial or conversation-only tasks, repo-meta/doc-only changes
  without behavior impact, or when the user explicitly says not to include it.

## Inputs to Collect Automatically (do not ask the user)

- Current branch: `git rev-parse --abbrev-ref HEAD`
- Working tree: `git status -sb`
- Untracked files: `git ls-files --others --exclude-standard`
- Changed files:
  - unstaged: `git diff --name-only`
  - staged: `git diff --name-only --cached`
  - stats: `git diff --stat` and `git diff --stat --cached`
- Base reference:
  - `BASE_REF=$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/master)`
  - `BASE_COMMIT=$(git merge-base --fork-point "$BASE_REF" HEAD || git merge-base "$BASE_REF" HEAD || echo "$BASE_REF")`
- Commits ahead of the base fork point:
  `git log --oneline --no-merges ${BASE_COMMIT}..HEAD`
- Category signals for this repo:
  - runtime: `packages/core/**`, `packages/react/**`, `packages/indexeddb/**`,
    `packages/expo-sqlite/**`, `packages/sqlite3/**`,
    `packages/sqlite-bun/**`, `packages/adapter-tests/**`, `scripts/**`
  - tests: `packages/core/test/**`, `packages/*/src/test/**`,
    `scripts/test-integration.sh`, `scripts/auth_mint/**`
  - docs: `packages/docs/**`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`
  - build/test/release config: `package.json`, `bun.lock`, `.changeset/**`,
    `.github/workflows/**`, `tsconfig*.json`, `packages/*/tsconfig*.json`,
    `packages/*/vitest.config.ts`, `packages/react/eslint.config.js`,
    `.prettierrc`, `.prettierignore`
- Title scope mapping:
  - `core` -> `packages/core/**`
  - `react` -> `packages/react/**`
  - `indexeddb` -> `packages/indexeddb/**`
  - `expo-sqlite` -> `packages/expo-sqlite/**`
  - `sqlite3` -> `packages/sqlite3/**`
  - `sqlite-bun` -> `packages/sqlite-bun/**`
  - `adapter-tests` -> `packages/adapter-tests/**`
  - `docs` -> `packages/docs/**`
  - use no scope for repo-wide or multi-area changes

## Workflow

1. Run the commands above without asking the user.
2. If there are no staged, unstaged, or untracked changes and no commits ahead
   of `${BASE_COMMIT}`, reply briefly that no code changes were detected and do
   not emit the PR block.
3. Infer the change type from the touched paths:
   - `feat` for new user-facing or public functionality
   - `fix` for bug fixes or correctness issues
   - `docs` for documentation-only changes
   - `test` for test-only changes
   - `refactor` for internal cleanup without intended behavior change
   - `chore` for maintenance, tooling, workflow, or release housekeeping
4. Pick the title scope from the mapping above when one package or area clearly
   dominates. If the diff spans multiple major areas, omit the scope.
5. Summarize the change in 1-3 short sentences using the most important paths
   and `git diff --stat`. Explicitly mention untracked files because `--stat`
   does not include them. If the worktree is clean but there are commits ahead
   of `${BASE_COMMIT}`, summarize from those commit messages.
6. Explain the problem being solved, not just the implementation. For bug fixes,
   include the symptom, failure mode, or repro. For features, explain the user
   or maintainer need.
7. Include verification steps in the PR description. Prefer the smallest
   relevant commands that were actually run. If no verification was run, say so
   plainly rather than inventing coverage.
8. If the change touches a published package or public docs for a published
   package, check whether a new file was added under `.changeset/`. Mention the
   changeset in the draft description when relevant; if none was added, call
   that out briefly instead of guessing.
9. Flag compatibility risk only when the diff changes released public APIs,
   package exports, persisted data, release configuration, or wire/protocol
   behavior.
10. Suggest a branch name. If already off `master`, keep the current branch.
    Otherwise propose `feat/<slug>`, `fix/<slug>`, `docs/<slug>`,
    `refactor/<slug>`, `test/<slug>`, or `chore/<slug>`.
11. If the current branch matches `issue-<number>` (digits only), keep that
    branch suggestion. When an issue number is present, reference
    `https://github.com/cashubtc/coco/issues/<number>` and include
    `This pull request resolves #<number>.`
12. If the change affects UI or docs visuals, add a short reminder in the
    description to attach screenshots or preview images.
13. Draft the PR title and description using the template below.
14. Output only the block in "Output Format", with at most a very short status
    note before it.

## Title guidance

- Use an imperative Conventional Commit-style title.
- Prefer a scope when the affected package or area is clear:
  - `fix(core): prevent duplicate quote sync`
  - `feat(react): add wallet provider reset hook`
  - `docs(docs): clarify adapter setup`
- Use an unscoped title for repo-wide work:
  - `chore: update release workflow`
- Keep the title specific to the user-visible or reviewer-relevant outcome, not
  the internal mechanism.

## Output Format

When closing out a task, add this concise Markdown block after any brief status
note unless the task falls under the documented skip cases or the user says they
do not want it.

```md
# Pull Request Draft

## Branch name suggestion

git checkout -b <branch-name>

## Title

<type[(scope)] : imperative summary>

## Description

This pull request <adds|fixes|updates|improves> ...

## Problem

<what was broken, missing, unclear, or risky, and why this change was needed>

## Summary

- <key change>
- <key change>
- <optional compatibility note, screenshot reminder, or follow-up note>

## Verification

- <command actually run>
- <command actually run>

## Changeset

- <added `.changeset/...md` or explain why one was not added when relevant>
```

Keep it tight. Do not pad the description with generic filler, and do not claim
tests or screenshots that were not actually produced.
