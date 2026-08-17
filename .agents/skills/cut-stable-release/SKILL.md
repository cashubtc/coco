---
name: cut-stable-release
description: Cut a coco stable release from `master` or finalize a selected RC cutoff from an existing `release/X.Y.Z-rc` branch while `master` continues independently. Use when the user asks to create a stable `vX.Y.Z` release, preserve an RC's runtime source, finalize Changesets prerelease metadata, validate and build the release, commit and tag it, and push the source branch plus tag. Supports dry-run, preview, and rehearsal requests by stopping before push.
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
- For stable-from-RC releases, preserve the selected RC as the source cutoff.
  The stable commit may change only Changesets metadata, package manifests,
  and package changelogs.
- Keep `master` work that landed after the RC out of the stable tag. Back-merge
  the stable release metadata into `master` after the release cut.
- Treat `dry run`, `dry-run`, `--dry-run`, `preview`, or `rehearsal` as a
  request to create the local commit and tag but skip pushing.
- Networked git commands usually need escalation.

## Choose The Path

- Direct stable release: start from `master` with pending changesets and no RC
  cycle.
- Final stable after RCs: start from the existing `release/X.Y.Z-rc` branch,
  require its HEAD to be the selected RC tag, then create one stable metadata
  commit directly on that cutoff. `master` may have advanced independently.

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
   RELEASE_BRANCH="$(git branch --show-current)"
   git fetch origin "$RELEASE_BRANCH" --tags
   git pull --ff-only origin "$RELEASE_BRANCH"
   ```

3. Select the RC cutoff at branch HEAD:

   ```bash
   RC_CUTOFF_TAG="$(git tag --points-at HEAD --list 'v*-rc.*' --sort=-v:refname | head -n 1)"
   test -n "$RC_CUTOFF_TAG"
   RC_CUTOFF_COMMIT="$(git rev-parse "$RC_CUTOFF_TAG^{commit}")"
   test "$(git rev-parse HEAD)" = "$RC_CUTOFF_COMMIT"
   ```

   Stop if the branch has commits after the selected RC. Runtime or repository
   changes after an RC require a new RC; they do not belong in the stable
   metadata commit.

4. Confirm `.changeset/pre.json` is present, then exit prerelease mode and
   generate stable versions:

   ```bash
   test -f .changeset/pre.json
   bunx changeset pre exit
   bunx changeset version
   ```

5. Continue at "Commit And Tag" with `RELEASE_BRANCH`, `RC_CUTOFF_TAG`, and
   `RC_CUTOFF_COMMIT` available in the shell.

## Commit And Tag

1. Derive release metadata from the versioned files:

   ```bash
   eval "$(.agents/skills/cut-stable-release/scripts/derive-stable-release-metadata.sh)"
   printf '%s\n' "$NEW_PACKAGE_VERSION" "$NEW_RELEASE_TAG" "$COMMIT_MESSAGE"
   ```

   For stable-from-RC, confirm that the stable tag matches the RC line:

   ```bash
   [[ "$RC_CUTOFF_TAG" == "${NEW_RELEASE_TAG}-rc."* ]]
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
   if [[ -n "${RC_CUTOFF_COMMIT:-}" ]]; then
     .agents/skills/cut-stable-release/scripts/check-stable-cutoff.sh \
       "$RC_CUTOFF_COMMIT"
   fi
   ```

   Expect only `.changeset/`, `packages/*/package.json`, and
   `packages/*/CHANGELOG.md` release-file changes. Stop if unrelated files
   changed.

4. Commit and tag:

   ```bash
   git add .changeset packages/*/package.json packages/*/CHANGELOG.md
   git commit -m "$COMMIT_MESSAGE"
   if [[ -n "${RC_CUTOFF_COMMIT:-}" ]]; then
     .agents/skills/cut-stable-release/scripts/check-stable-cutoff.sh \
       "$RC_CUTOFF_COMMIT" HEAD
   fi
   git tag "$NEW_RELEASE_TAG"
   ```

5. Push according to the selected path.

   Direct stable normal mode:

   ```bash
   git push --atomic origin master "refs/tags/$NEW_RELEASE_TAG"
   ```

   Stable from RC normal mode:

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

6. Report the package version, tag, commit SHA, and whether this was direct
   stable or stable-from-RC. For stable-from-RC, also report the cutoff tag,
   cutoff commit, release branch, that `master` was intentionally unchanged,
   whether the release branch plus tag were pushed or left local, and that the
   normal back-merge into `master` remains a separate follow-up.

## Back-Merge After A Stable RC Release

The stable tag remains on the direct child of the selected RC cutoff. After the
release branch and tag are pushed, merge the stable release commit back into
current `master` through the repository's normal review or merge process. A
normal merge commit is expected because `master` can contain post-cutoff work.
This back-merge records stable versions and consumed changesets on `master`; it
does not change the stable tag or add post-cutoff work to the release.

Treat the back-merge as a separate operation that requires its own user
authorization. Do not perform it during a dry run.

## Notes

- If validation fails, fix the release files before tagging. Do not bypass
  `scripts/check-release.ts`.
- For stable-from-RC, stop if the stable candidate is not a direct child of the
  selected RC or changes files outside the permitted release metadata paths.
- If runtime source must change, cut another RC before stable finalization.
