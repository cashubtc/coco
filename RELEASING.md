# Releasing

This repo publishes packages with Changesets and GitHub Releases. Stable releases
and prereleases follow the same rule: package versions and changelogs must be
committed before the GitHub Release is published.

The publish workflows build and publish the tagged commit. They do not create
release commits in CI.

## Prerequisites

- Start from the release branch, usually `master`.
- Make sure all intended changes are merged.
- Make sure package-impacting changes have changesets in `.changeset/`.
- Make sure the worktree is clean before generating release files:

```bash
git status --short
```

## RC releases

Use this flow for prerelease packages published to the npm `rc` dist-tag.

1. Enter Changesets prerelease mode:

```bash
bunx changeset pre enter rc
```

2. Generate prerelease versions and changelogs:

```bash
bunx changeset version
```

3. Normalize the RC number against npm:

```bash
bun scripts/prepare-rc-release.ts
```

This script checks published npm versions and rewrites publishable packages to
the next available `X.Y.Z-rc.N` version for the generated base version.

4. Review the generated release files:

```bash
git diff
```

Confirm that publishable package versions are aligned, internal published package
dependencies point at the same RC version, and changelogs contain the expected
entries.

5. Run a local build before tagging:

```bash
bun install --frozen-lockfile
bun run build
```

6. Commit the generated release files:

```bash
git add .
git commit -m "version: release X.Y.Z-rc.N"
```

Use the actual generated version in the commit message.

7. Tag the release commit:

```bash
git tag vX.Y.Z-rc.N
```

8. Push the commit and tag:

```bash
git push origin master
git push origin vX.Y.Z-rc.N
```

9. Create a GitHub Release for the tag and mark it as a prerelease.

Publishing the prerelease GitHub Release runs the `publish-rc` job in
`.github/workflows/publish.yml`. That job:

- checks dependency release age
- installs dependencies with the lockfile
- verifies committed RC versions with `scripts/check-prerelease-release.ts`
- builds packages
- publishes with `bunx changeset publish --tag rc`

10. Verify npm after the workflow succeeds:

```bash
npm view @cashu/coco-core dist-tags
npm view @cashu/coco-core@rc version
```

Users can install the RC with:

```bash
npm install @cashu/coco-core@rc
```

## Stable releases

Use this flow for stable packages published to the default npm dist-tag.

1. If the repo is currently in Changesets prerelease mode, exit it:

```bash
bunx changeset pre exit
```

Skip this step if the release is not following an RC cycle.

2. Generate stable versions and changelogs:

```bash
bunx changeset version
```

3. Review the generated release files:

```bash
git diff
```

Confirm that publishable package versions are aligned, internal published package
dependencies point at the same stable version, and changelogs contain the
expected entries.

4. Run a local build before tagging:

```bash
bun install --frozen-lockfile
bun run build
```

5. Commit the generated release files:

```bash
git add .
git commit -m "version: release X.Y.Z"
```

Use the actual generated version in the commit message.

6. Tag the release commit:

```bash
git tag vX.Y.Z
```

7. Push the commit and tag:

```bash
git push origin master
git push origin vX.Y.Z
```

8. Create a GitHub Release for the tag. Do not mark it as a prerelease.

Publishing the stable GitHub Release runs the `publish` job in
`.github/workflows/publish.yml`. That job:

- checks dependency release age
- installs dependencies with the lockfile
- builds packages
- publishes with `bunx changeset publish`

9. Verify npm after the workflow succeeds:

```bash
npm view @cashu/coco-core dist-tags
npm view @cashu/coco-core@latest version
```

## If something looks wrong before publishing

If the generated versions, changelogs, or tags are wrong before the GitHub
Release is published, fix them before publishing. Do not rely on CI to repair
release files.

For an unpushed local release commit or tag, make the correction locally and
retag the corrected commit. For a pushed tag, coordinate with maintainers before
moving or replacing it.

## If npm publishing fails

Fix the failing condition on a new commit, create a new tag, and publish a new
GitHub Release. Do not reuse a tag for a different package artifact after npm has
accepted any package from that tag.
