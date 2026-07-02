# Releasing

This repo publishes packages with Changesets and GitHub Releases. The release tag
is the source of truth for npm artifacts: package versions, internal published
package dependencies, and changelog headings must be committed before the tag is
created.

The publish workflow checks out the GitHub Release tag, validates the committed
release files, builds, and publishes. It does not create or modify release files
in CI.

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

8. Push the commit and tag:

```bash
git push origin master
git push origin vX.Y.Z
```

If the stable release was finalized on a prerelease branch, fast-forward `master`
to the stable release commit before pushing `master` and the tag.

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
`bunx changeset version` again. Changesets increments the prerelease number from
the committed `.changeset/pre.json` state.

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
publishing with `bunx changeset publish --tag rc`.

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
