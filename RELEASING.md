# Releasing

This repo publishes packages with Changesets and GitHub Releases. The release tag
is the source of truth for npm artifacts: package versions, internal published
package dependencies, and changelog headings must be committed before the tag is
created.

The publish workflow checks out the GitHub Release tag, validates the committed
release files, builds, and publishes. It does not create or modify release files
in CI.

## Prerequisites

- Use the Bun version configured in the publish workflow. Changesets runs under
  Node even when invoked with `bunx`; Node 24 matches publishing CI. Changesets
  supports Node `^22.11 || ^24 || >=26` and npm `>=10.9.0`; npm trusted publishing
  requires npm `>=11.5.1` and Node `>=22.14.0`. Check `node --version` and
  `npm --version` on release machines.
- Make sure all intended changes are merged into the release branch.
- Make sure package-impacting changes have changesets in `.changeset/`.
- Make sure the worktree is clean before generating release files:

```bash
git status --short
```

### Changesets v3 and existing RC branches

Upgrade the release toolchain before starting an RC cycle. If an existing v2 RC
branch must migrate, run `bunx changeset status` after upgrading, review and commit
the moved changesets and updated `.changeset/pre.json`, then qualify a new RC.
`status` can modify v2 prerelease state. Keep a selected RC cutoff's toolchain
through stable finalization; a dependency upgrade is outside that metadata-only
commit.

V3 moves changesets consumed by RCs into `.changeset/pre/`. Commit that directory
along with `pre.json`; its entries become the stable changelog. The top-level
`.changeset/*.md` files represent pending work for the next RC. Before exiting
prerelease mode, review the historical entries for the stable release. The final
`changeset version` consumes them and removes `pre.json`.

Keep private-package versioning enabled in `.changeset/config.json`: SQL storage
is private but shares changesets with public packages. Keep `cocod` ignored.
Peer dependency updates now propagate patch bumps; explicitly mark incompatible
changes as major. The public packages still release together as a fixed group.

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
bunx changeset version
```

4. Review the generated release files:

```bash
git diff
```

Confirm that publishable package versions are aligned, internal published package
dependencies point at the same stable version, and each publishable package
changelog starts with that version.

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
bunx changeset version
```

For follow-up RCs in the same cycle, add or merge the new changesets, then run
`bunx changeset version` again. Changesets derives the next prerelease number from
the committed package versions. An RC run with only historical entries in
`.changeset/pre/` does not advance the version; add the intended new changesets
before cutting another RC. Outside prerelease mode, `version` fails when there
are no unreleased changesets.

4. Review the generated release files:

```bash
git diff
```

Confirm that publishable package versions are aligned, internal published package
dependencies point at the same RC version, and each publishable package changelog
starts with that RC version.

5. Run a local build before tagging:

```bash
bun install --frozen-lockfile
bun run build
```

6. Commit the generated release files, including `.changeset/pre.json` and
   `.changeset/pre/`:

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
