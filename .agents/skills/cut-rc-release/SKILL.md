---
name: cut-rc-release
description: Cut a coco prerelease/RC from a dedicated `release/X.Y.Z-rc` branch. Use when the user asks to create a first or follow-up `vX.Y.Z-rc.N` release, version packages in Changesets prerelease mode, commit `.changeset/pre.json` plus package manifests and changelogs, tag the release commit, and push the prerelease branch and tag. Supports dry-run, preview, and rehearsal requests by stopping before push.
---

# Cut RC Release

## Purpose

Run the local git-side workflow for a coco RC release. This skill prepares the
release commit and tag only; npm publish happens later when a GitHub prerelease
is created for the tag.

Use this for tags like `v2.0.0-rc.0`. Do not use it for stable `vX.Y.Z`
releases; use `$cut-stable-release` instead.

## Safety

- Work from a clean worktree. If `git status -sb` shows local changes, stop.
- Use a dedicated prerelease branch named `release/X.Y.Z-rc`.
- Do not run `changeset publish` and do not create a GitHub Release from this
  skill. The publish workflow validates the committed `.changeset/pre.json`,
  removes it only in the CI checkout, and publishes with `--tag rc`.
- Treat `dry run`, `dry-run`, `--dry-run`, `preview`, or `rehearsal` as a
  request to create the local commit and tag but skip pushing.
- Networked git commands usually need escalation.

## Workflow

1. Decide whether this is dry-run mode.

2. Confirm the worktree is clean:

   ```bash
   git status -sb
   ```

3. Confirm or create the prerelease branch.

   If already on `release/X.Y.Z-rc`, continue. If starting a new RC cycle from
   `master`, sync `master` and create the prerelease branch:

   ```bash
   git fetch origin master --tags
   git switch master
   git pull --ff-only origin master
   git switch -c release/X.Y.Z-rc
   ```

   If the current worktree is not a dedicated release worktree, create a new
   worktree instead of switching a feature worktree in place.

4. Confirm there are pending changesets:

   ```bash
   find .changeset -maxdepth 1 -type f -name '*.md' ! -name 'README.md' | sort
   ```

   If this is empty, stop unless the user explicitly asked for a no-change RC.

5. Enter prerelease mode only when needed:

   ```bash
   test -f .changeset/pre.json || bunx changeset pre enter rc
   ```

   If `.changeset/pre.json` exists, inspect it before continuing. It must have
   `mode: "pre"` and `tag: "rc"`.

6. Generate prerelease versions and changelogs:

   ```bash
   bunx changeset version
   ```

7. Derive release metadata from the versioned files:

   ```bash
   eval "$(.agents/skills/cut-rc-release/scripts/derive-rc-release-metadata.sh)"
   printf '%s\n' "$NEW_PACKAGE_VERSION" "$NEW_RELEASE_TAG" "$RELEASE_BRANCH" "$COMMIT_MESSAGE"
   ```

8. Validate the committed release state and build:

   ```bash
   env RELEASE_TAG="$NEW_RELEASE_TAG" RELEASE_PRERELEASE=true PRERELEASE_TAG=rc \
     bun scripts/check-release.ts
   bun install --frozen-lockfile
   bun run build
   ```

9. Review the diff before committing:

   ```bash
   git diff --name-only
   git diff --stat
   ```

   Expect only `.changeset/`, `packages/*/package.json`, and
   `packages/*/CHANGELOG.md` release-file changes. Stop if unrelated files
   changed.

10. Commit and tag:

    ```bash
    git add .changeset packages/*/package.json packages/*/CHANGELOG.md
    git commit -m "$COMMIT_MESSAGE"
    git tag "$NEW_RELEASE_TAG"
    ```

11. Finish.

    Normal mode:

    ```bash
    git push --atomic origin "$RELEASE_BRANCH" "refs/tags/$NEW_RELEASE_TAG"
    ```

    Dry-run mode:

    ```bash
    git status -sb
    git log --decorate --oneline -1
    git show --stat --decorate --no-patch HEAD
    git tag --list "$NEW_RELEASE_TAG"
    ```

12. Report the package version, tag, release branch, commit SHA, and whether the
    branch/tag were pushed or intentionally left local.

## Notes

- For a follow-up RC, merge or otherwise bring the intended changesets onto the
  existing prerelease branch first, then run this workflow from step 4.
- If validation fails, fix the release files before tagging. Do not bypass
  `scripts/check-release.ts`.
