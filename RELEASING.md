# Releasing

This repo publishes packages with Changesets and GitHub Releases. The release tag
is the source of truth for npm artifacts: package versions, internal published
package dependencies, and changelog headings must be committed before the tag is
created.

The publish workflow checks out the GitHub Release tag, validates the committed
release files, builds, and publishes. It does not create or modify release files
in CI.

Core packages share the fixed version group in `.changeset/config.json` and use
`vX.Y.Z` / `vX.Y.Z-rc.N` release tags. `@cashu/coco-fountain` is versioned
independently and uses `coco-fountain-vX.Y.Z` tags. Its APIs and binary wire format
remain experimental during the 0.x series.

Fountain is ignored by Changesets. Core releases must use `bun run version:core`,
which also preserves fountain release files around a Changesets 2.29.x prerelease-exit
bug that can otherwise patch ignored packages. Use `bun run version:fountain` to
consume only fountain changesets. Keep
fountain and core changes in separate changeset files; Changesets rejects a file
that mixes an ignored package with a selected package.

Publishing selects packages by release tag. `scripts/prepare-publish.ts` validates
the selected release and marks other public packages private **only in the CI
checkout**, before Changesets discovers packages to publish. Changesets' `ignore`
setting controls versioning, not publishing. Never use a bare `changeset publish`
from an unscoped checkout; use the GitHub Release workflow.

## Prerequisites

- Make sure all intended changes are merged into the release branch.
- Make sure package-impacting changes have changesets in `.changeset/`.
- Make sure the worktree is clean before generating release files:

```bash
git status --short
```

## Stable Releases

Use this flow for stable packages published to the default npm dist-tag.

1. Start from the branch that will contain the release commit.

For a stable release that does not follow an RC cycle, use `master`:

```bash
git switch master
git pull --ff-only
```

For a stable release after an RC cycle, use the prerelease branch that contains
`.changeset/pre.json` and the latest RC release files:

```bash
git switch release/X.Y.Z-rc
git pull --ff-only
```

2. If the stable release follows an RC cycle, exit Changesets prerelease mode:

```bash
bunx changeset pre exit
```

Skip this step when `.changeset/pre.json` is not present.

3. Generate stable versions and changelogs:

```bash
bun run version:core
```

4. Review the generated release files:

```bash
git diff
```

Confirm that core fixed-group package versions are aligned, their internal package
dependencies point at the same stable version, and each selected package changelog
starts with that version. Fountain files and pending changesets must be unchanged.

5. Run a local build before tagging:

```bash
bun install --frozen-lockfile
bun run build
```

6. Commit the generated release files:

```bash
git add .
git commit -m "version: release X.Y.Z"
```

Use the actual generated version in the commit message.

7. Tag the release commit:

```bash
git tag vX.Y.Z
```

8. Push the source branch and tag. For a release cut directly from `master`:

```bash
git push origin master
git push origin vX.Y.Z
```

For a stable release finalized on a prerelease branch:

```bash
git push origin release/X.Y.Z-rc
git push origin vX.Y.Z
```

Keep the stable tag on the release commit so it preserves the selected RC source
cutoff while development continues on `master`.

9. Create a GitHub Release for the tag. Do not mark it as a prerelease.

Publishing the GitHub Release runs `.github/workflows/publish.yml`. The workflow
checks that the tag, GitHub Release prerelease flag, committed package versions,
internal published package dependencies, and changelogs agree before publishing
with `bunx changeset publish`.

10. Verify npm after the workflow succeeds:

```bash
npm view @cashu/coco-core dist-tags
npm view @cashu/coco-core@latest version
```

11. If the release was finalized on a prerelease branch, open a follow-up PR that
    merges the stable release commit into current `master`.

Use a merge commit to preserve release ancestry; `master` may have advanced beyond
the RC cutoff, so a fast-forward may not be possible. Preserve newer source changes
and pending changesets while bringing in the released package versions, internal
dependency versions, changelogs, and removal of consumed changesets. Refresh
`bun.lock` with `bun install`, then verify a frozen install, build, and typecheck.
Merge the PR with a merge commit so the release remains an ancestor of `master`.
The existing stable tag stays unchanged.

## RC Releases

Use this flow for prerelease packages published to the npm `rc` dist-tag. Keep RC
cycles on a dedicated prerelease branch instead of putting Changesets prerelease
mode on `master`.

1. Create or update the prerelease branch:

```bash
git switch master
git pull --ff-only
git switch -c release/X.Y.Z-rc
```

For a follow-up RC in the same cycle, switch to the existing prerelease branch
and merge or rebase the intended changes into it.

2. Enter Changesets prerelease mode only once per RC cycle:

```bash
bunx changeset pre enter rc
```

Skip this step when `.changeset/pre.json` is already present on the prerelease
branch.

3. Generate prerelease versions and changelogs:

```bash
bun run version:core
```

For follow-up RCs in the same cycle, add or merge the new changesets, then run
`bun run version:core` again. Changesets increments the prerelease number from
the committed `.changeset/pre.json` state.

4. Review the generated release files:

```bash
git diff
```

Confirm that core fixed-group package versions are aligned, their internal package
dependencies point at the same RC version, and each selected package changelog
starts with that RC version. Fountain files and pending changesets must be unchanged.

5. Run a local build before tagging:

```bash
bun install --frozen-lockfile
bun run build
```

6. Commit the generated release files, including `.changeset/pre.json`:

```bash
git add .
git commit -m "version: release X.Y.Z-rc.N"
```

Use the actual generated RC version in the commit message.

7. Tag the release commit:

```bash
git tag vX.Y.Z-rc.N
```

8. Push the prerelease branch and tag:

```bash
git push origin release/X.Y.Z-rc
git push origin vX.Y.Z-rc.N
```

9. Create a GitHub Release for the tag and mark it as a prerelease.

Publishing the GitHub prerelease runs `.github/workflows/publish.yml`. The
workflow checks that the tag, GitHub Release prerelease flag, committed package
versions, internal published package dependencies, and changelogs agree before
publishing. The release commit keeps `.changeset/pre.json`, but the workflow
removes that file only in the CI checkout before running
`bunx changeset publish --tag rc`; Changesets does not allow `--tag` while pre
mode is present, and relying on implicit pre-mode tagging can send packages that
only have prerelease versions to npm's `latest` dist-tag.

10. Verify npm after the workflow succeeds:

```bash
npm view @cashu/coco-core dist-tags
npm view @cashu/coco-core@rc version
```

Users can install the RC with:

```bash
npm install @cashu/coco-core@rc
```

## Independent Fountain Releases

Prepare fountain from a clean checkout outside Changesets prerelease mode (normally
`master`). Do not enter global prerelease mode for fountain. The current policy
publishes ordinary 0.x versions to fountain's own npm `latest` tag; it does not
publish alpha/RC tags or imply a stable protocol contract.

1. Add a fountain-only changeset in `.changeset/`. Because fountain is excluded
   from the default Changesets command, write it directly, for example:

   ```md
   ---
   '@cashu/coco-fountain': patch
   ---

   Describe the fountain change.
   ```

2. Run `bun run version:fountain`, then `bun install` to refresh `bun.lock`.
   The command temporarily selects only fountain for Changesets versioning and
   restores the normal configuration, including on failure. It rejects an active
   or exiting core prerelease cycle. Review the manifest, changelog, and consumed
   changesets; core versions and changesets must be unchanged. The new package
   starts at `0.0.0`; its initial minor changeset produces `0.1.0`.
3. Run `bun install --frozen-lockfile`, `bun run --cwd packages/fountain test`,
   `bun run --cwd packages/fountain typecheck`, and the package's `test:browser`
   and `test:package` scripts. Run `bun run test:release` for release isolation.
4. Validate using the generated version (replace `0.1.0` as appropriate):

   ```bash
   RELEASE_TAG=coco-fountain-v0.1.0 RELEASE_PRERELEASE=false bun scripts/check-release.ts
   ```

5. Commit the release files, tag that commit `coco-fountain-v0.1.0`, push the
   source branch and tag, and create a GitHub Release for the tag. Do not mark it
   as a GitHub prerelease. The `publish-fountain` job validates and publishes only
   `@cashu/coco-fountain`; core versions need not match.
6. Verify with `npm view @cashu/coco-fountain@latest version`.

Before the first publish, configure npm publishing access for the scoped package
and this workflow. Neither local versioning command publishes packages.

## If Something Looks Wrong Before Publishing

If the generated versions, changelogs, or tags are wrong before the GitHub
Release is published, fix them before publishing. Do not rely on CI to repair
release files.

For an unpushed local release commit or tag, make the correction locally and
retag the corrected commit. For a pushed tag, coordinate with maintainers before
moving or replacing it.

## If npm Publishing Fails

Fix the failing condition on a new commit, create a new tag, and publish a new
GitHub Release. Do not reuse a tag for a different package artifact after npm has
accepted any package from that tag.
