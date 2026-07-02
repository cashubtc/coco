---
name: cut-stable-release
description: Cut a coco stable release from `master` or finalize one from an existing `release/X.Y.Z-rc` branch. Use when the user asks to create a stable `vX.Y.Z` release, run `changeset version` or `changeset pre exit` plus versioning, validate committed package manifests/changelogs, commit the release files, tag the release commit, and push `master` plus the tag. Supports dry-run, preview, and rehearsal requests by stopping before push.
---

# Cut Stable Release

## Purpose

Run the local git-side workflow for a stable coco release. This skill prepares
the stable release commit and tag only; npm publish happens later when a GitHub
Release is created for the tag.

Use this for tags like `v2.0.0`. Use `$cut-rc-release` for RC tags like
`v2.0.0-rc.0`.

## Safety

- Work from a clean dedicated release worktree. If `git status -sb` shows local
  changes, stop.
- Do not run `changeset publish` and do not create a GitHub Release from this
  skill.
- Stable release tags must not contain `.changeset/pre.json`; the repo
  validator enforces this.
- Treat `dry run`, `dry-run`, `--dry-run`, `preview`, or `rehearsal` as a
  request to create the local commit and tag but skip pushing.
- Networked git commands usually need escalation.

## Choose The Path

- Direct stable release: start from `master` with pending changesets and no RC
  cycle.
- Final stable after RCs: start from the existing `release/X.Y.Z-rc` branch,
  run `changeset pre exit`, then version the stable release. After committing,
  fast-forward `master` to that stable release commit.

## Direct Stable Workflow

1. Confirm the worktree is clean and on `master`:

   ```bash
   git status -sb
   git branch --show-current
   ```

2. Sync `master`:

   ```bash
   git fetch origin master --tags
   git pull --ff-only origin master
   ```

3. Confirm there are pending changesets:

   ```bash
   find .changeset -maxdepth 1 -type f -name '*.md' ! -name 'README.md' | sort
   ```

   If this is empty, stop rather than creating a no-op release.

4. Generate stable versions and changelogs:

   ```bash
   bunx changeset version
   ```

5. Continue at "Commit And Tag".

## Stable From RC Workflow

1. Confirm the worktree is clean and on the RC branch:

   ```bash
   git status -sb
   git branch --show-current
   ```

   The branch should be `release/X.Y.Z-rc`.

2. Sync the branch and tags:

   ```bash
   git fetch origin --tags
   git pull --ff-only
   ```

3. Confirm `.changeset/pre.json` is present, then exit prerelease mode and
   generate stable versions:

   ```bash
   test -f .changeset/pre.json
   bunx changeset pre exit
   bunx changeset version
   ```

4. Continue at "Commit And Tag". After committing, this path must fast-forward
   `master` to the stable release commit before pushing.

## Commit And Tag

1. Derive release metadata from the versioned files:

   ```bash
   eval "$(.agents/skills/cut-stable-release/scripts/derive-stable-release-metadata.sh)"
   printf '%s\n' "$NEW_PACKAGE_VERSION" "$NEW_RELEASE_TAG" "$COMMIT_MESSAGE"
   ```

2. Validate the committed release state and build:

   ```bash
   env RELEASE_TAG="$NEW_RELEASE_TAG" RELEASE_PRERELEASE=false PRERELEASE_TAG=rc \
     bun scripts/check-release.ts
   bun install --frozen-lockfile
   bun run build
   ```

3. Review the diff before committing:

   ```bash
   git diff --name-only
   git diff --stat
   ```

   Expect only `.changeset/`, `packages/*/package.json`, and
   `packages/*/CHANGELOG.md` release-file changes. Stop if unrelated files
   changed.

4. Commit and tag:

   ```bash
   git add .changeset packages/*/package.json packages/*/CHANGELOG.md
   git commit -m "$COMMIT_MESSAGE"
   git tag "$NEW_RELEASE_TAG"
   ```

5. Push according to the selected path.

   Direct stable normal mode:

   ```bash
   git push --atomic origin master "refs/tags/$NEW_RELEASE_TAG"
   ```

   Stable from RC normal mode:

   ```bash
   stable_commit="$(git rev-parse HEAD)"
   git fetch origin master --tags
   git switch master
   git pull --ff-only origin master
   git merge --ff-only "$stable_commit"
   git push --atomic origin master "refs/tags/$NEW_RELEASE_TAG"
   ```

   Dry-run mode:

   ```bash
   git status -sb
   git log --decorate --oneline -1
   git show --stat --decorate --no-patch HEAD
   git tag --list "$NEW_RELEASE_TAG"
   ```

6. Report the package version, tag, commit SHA, whether this was direct stable
   or stable-from-RC, and whether `master` plus the tag were pushed or left
   local for dry-run.

## Notes

- If validation fails, fix the release files before tagging. Do not bypass
  `scripts/check-release.ts`.
- For stable-from-RC, stop if `master` cannot fast-forward to the stable release
  commit. Do not create a merge commit on `master` during release finalization.
