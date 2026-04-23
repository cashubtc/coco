---
name: cut-release
description: Cut a coco release from a dedicated `master` worktree by fast-forwarding `master`, running `bunx changeset version`, verifying the fixed package versions and changelogs, deriving the release commit/tag name from the latest repo tag, committing the versioned files, creating the tag, and pushing both the commit and tag.
---

# Cut Release

## Purpose

Run the git-side release flow for `cashubtc/coco` from a dedicated `master`
worktree:
sync `master` with `origin/master`, apply pending changesets, verify the fixed
release group was bumped together, derive the release commit/tag name from the
latest repo tag, commit the versioned files, create the release tag, and push
both the branch update and the tag.

This skill does not create a GitHub Release. In this repo, npm publishing is
handled later by `.github/workflows/publish.yml` when a GitHub release is
created.

It also supports a dry-run mode that performs the same local release steps but
stops before pushing the commit and tag to `origin`.

## When to Trigger

- The user asks to cut, version, tag, or push a repo release.
- The user asks for a release dry run, preview, rehearsal, or `--dry-run`.
- Use it after the release-worthy changes are already merged and the repo has
  pending changesets ready to version.

## Safety

- Start from a clean worktree. If `git status -sb` shows changes, stop and tell
  the user instead of trying to carry local edits through the release.
- Do not switch a feature worktree to `master` just to cut the release. This
  repo commonly uses one worktree per feature branch, so repurposing the
  current worktree can fail or disturb ongoing work.
- If the current branch is not `master`, stop and tell the user to rerun the
  release from a dedicated `master` worktree, or create one only if the user
  explicitly asks you to do that.
- Use non-interactive git commands only.
- Networked git commands often need escalation. Request approval for `git fetch`,
  `git pull`, and `git push` when sandboxing blocks them.
- Do not create an empty release. If there are no pending changeset markdown
  files under `.changeset/` other than repo metadata like `README.md`, stop.
- In dry-run mode, still create the local release commit and tag. Only the push
  step is skipped.

## Repo-specific facts

- Changesets is configured with `baseBranch: "master"` in `.changeset/config.json`.
- Published packages are released as one fixed group:
  `@cashu/coco-core`, `@cashu/coco-indexeddb`, `@cashu/coco-expo-sqlite`,
  `@cashu/coco-sqlite`, `@cashu/coco-sqlite-bun`,
  `@cashu/coco-adapter-tests`, and `@cashu/coco-react`.
- Recent release commits use `version: <tag>`.
- Recent release tags use the annotated `stable-v<major>.RC<rc>` format, for
  example `stable-v1.RC3`.
- Package manifests currently use semver prerelease versions like
  `1.0.0-rc.3`. The helper script below maps that package version to the repo
  tag format and refuses to guess if the tag scheme changes.

## Bundled helper

- Run `.agents/skills/cut-release/scripts/derive-release-metadata.sh` after
  `bunx changeset version`.
- It validates that every package in the fixed release group shares the same
  version, checks that the derived release tag is ahead of the latest repo tag,
  and prints shell-ready variables such as `NEW_RELEASE_TAG`.

## Workflow

Before running the steps below, decide whether the user requested dry-run mode.
Treat `dry run`, `dry-run`, `--dry-run`, `preview`, or `rehearsal` as a request
to skip the push step while still creating the local release commit and tag.

1. Confirm the worktree is clean.

   ```bash
   git status -sb
   ```

   If the tree is not clean, stop.

2. Confirm there are pending changesets to consume.

   ```bash
   find .changeset -maxdepth 1 -type f -name '*.md' \
     ! -name 'README.md' | sort
   ```

   If this is empty, stop rather than creating a no-op version commit.

3. Confirm this worktree is already on `master`.

   ```bash
   git branch --show-current
   ```

   If the current branch is not `master`, stop and tell the user to rerun the
   release from a dedicated `master` worktree rather than switching branches in
   place.

4. Sync `master` to the remote release base.

   ```bash
   git fetch origin master --tags
   git pull --ff-only origin master
   git status -sb
   ```

   If `master` cannot fast-forward cleanly, stop and surface the conflict.

5. Apply the pending changesets.

   ```bash
   bunx changeset version
   ```

6. Validate the release metadata and derive the release tag.

   ```bash
   eval "$(.agents/skills/cut-release/scripts/derive-release-metadata.sh)"
   printf '%s\n' "$NEW_PACKAGE_VERSION" "$NEW_RELEASE_TAG" "$COMMIT_MESSAGE"
   ```

   The script exports:
   - `LAST_TAG`
   - `LAST_TAG_TYPE`
   - `NEW_PACKAGE_VERSION`
   - `NEW_RELEASE_TAG`
   - `COMMIT_MESSAGE`

7. Verify the versioned files look right before committing.

   ```bash
   git diff --name-only
   git diff --stat
   ```

   Expect versioning changes in:
   - `.changeset/` including consumed changeset deletions and `pre.json`
   - `packages/*/package.json`
   - `packages/*/CHANGELOG.md`

   If unrelated files changed, stop and inspect before committing.

8. Commit the versioning output with the repo’s release commit format.

   ```bash
   git add .changeset packages/*/package.json packages/*/CHANGELOG.md
   git commit -m "$COMMIT_MESSAGE"
   ```

9. Reuse the latest tag style.

   Inspect the latest tag object type:

   ```bash
   git cat-file -t "refs/tags/$LAST_TAG"
   ```

   If the latest tag is an annotated tag object, create an annotated tag:

   ```bash
   git tag -a "$NEW_RELEASE_TAG" -m "$NEW_RELEASE_TAG"
   ```

   If the latest tag points directly at a commit, use a lightweight tag instead:

   ```bash
   git tag "$NEW_RELEASE_TAG"
   ```

   In the current repo state, annotated tags are expected.

10. Finish in normal mode or dry-run mode.

Normal mode:

```bash
git push origin master
git push origin "$NEW_RELEASE_TAG"
```

Dry-run mode: stop before pushing and show the local result instead.

```bash
git status -sb
git log --decorate --oneline -1
git show --stat --decorate --no-patch HEAD
git tag --list "$NEW_RELEASE_TAG"
```

11. Report the release result.

Include the new package version, new tag, commit SHA, and whether you pushed
or intentionally stopped in dry-run mode. If any step was skipped or
blocked, say so plainly.

## Notes

- Do not rewrite history or amend older release commits unless the user
  explicitly asks.
- If the helper script fails because the tag format changed, stop and inspect
  the latest release tag manually instead of inventing a new naming scheme.
- A dry run leaves the local `master` branch one release commit ahead with the
  new local tag present. Do not clean that up unless the user explicitly asks.
