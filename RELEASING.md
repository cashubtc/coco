# Releasing

Changesets prepares release pull requests for `master` and `release/X.Y.Z-rc`
branches. Maintainers review and merge the generated files, then tag that exact
commit and publish a GitHub Release. Publishing the GitHub Release triggers npm
publication; merging a release PR does not publish packages.

The tag is the source of truth for npm artifacts. The publisher checks out the
tag, validates committed versions, internal dependencies, prerelease state, and
changelogs, then builds and publishes. It never generates release files.

## Repository Setup

Enable **Settings → Actions → General → Allow GitHub Actions to create and
approve pull requests**. The preparation workflow uses `GITHUB_TOKEN` with
`contents: write` and `pull-requests: write`, and needs no npm credentials.

GitHub may require a maintainer to approve workflow runs on a bot-created PR.
Use **Approve workflows to run** when prompted and wait for checks before merging.
For fully automatic PR checks, a repository-scoped GitHub App token can be used
for both checkout and the Changesets action instead of `GITHUB_TOKEN`.
See [GitHub's workflow triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

The workflow uses Changesets Action v1 with this repository's Changesets CLI v2.
It maintains one PR per base branch, from `changeset-release/<base-branch>`.
Runs are serialized per branch. **Prepare release PR** also supports a manual
workflow dispatch for retrying a failed run on the selected branch.

## Release PR Checks

Package changes must include changesets. The preparation workflow runs
`bun run release:version`, which versions packages, validates the release series,
and refreshes `bun.lock`. An RC branch must explicitly enter prerelease mode
before automation starts. After stable finalization removes `.changeset/pre.json`,
that branch becomes inactive.

The generated PR should contain only Changesets state, package manifests,
changelogs, and `bun.lock`. Review the package versions and changelog text. The
**Release PR checks** workflow validates the proposed release commit, frozen
install, build, and typecheck. It also tests the stable and RC versioning flows.

A branch name does not choose a version: Changesets calculates the version from
pending changesets. The generated version must match `X.Y.Z` in an RC branch's
name. If it does not, correct the branch or the changesets before releasing.

## Stable Releases From Master

1. Merge intended package changes and their changesets into `master`.
2. Wait for the bot to create or update **chore: prepare release** against
   `master`. New changesets update the same PR until it is merged.
3. Review the generated files, approve workflow runs if prompted, and wait for
   successful checks. Merge the release PR when ready.
4. Follow **Tag And Publish** below with the merged release commit and `vX.Y.Z`.

During an RC cycle, leave the release PR against `master` unmerged. Finalize the
stable release on its RC branch, then back-merge that release history. The bot
will refresh the `master` PR using the remaining changesets.

## Start An RC Cycle

Start from the intended source cutoff, with its pending changesets. Replace
`X.Y.Z` with the next version calculated by Changesets (inspect
`bunx changeset status` if needed):

```bash
git switch master
git pull --ff-only
git switch -c release/X.Y.Z-rc
bun install --frozen-lockfile
bunx changeset pre enter rc
git add .changeset/pre.json
git commit -m "chore: start X.Y.Z RC cycle"
git push -u origin release/X.Y.Z-rc
```

The bot opens a release PR **against the RC branch**, preparing `X.Y.Z-rc.0`,
changelogs, internal dependencies, the lockfile, and updated `.changeset/pre.json`.
Review and merge it after checks pass. Follow **Tag And Publish** with the merged
commit and `vX.Y.Z-rc.0`, marking the GitHub Release as a prerelease.

The workflow must exist on the RC branch. For a branch created before this
workflow was introduced, bring in the release automation before preparing a new
RC. Do not add workflow changes after the selected final RC cutoff.

## Follow-Up RCs

Merge only the intended fixes and their changesets into `release/X.Y.Z-rc`.
The bot prepares the next RC version PR against that branch. Review, merge, tag,
and publish it as above. Already consumed prerelease changesets do not create
another RC by themselves; new changesets drive the next version.

Keep `.changeset/pre.json` committed throughout the cycle. Do not re-enter
prerelease mode for each RC. Avoid merging unrelated newer `master` work into the
RC branch.

## Promote A Selected RC To Stable

The RC branch must still point at the selected, tagged RC. New changes after
that cutoff require another RC before promotion. Fetch tags and check the cutoff
before recording the intent to exit prerelease mode:

```bash
git switch release/X.Y.Z-rc
git pull --ff-only
git fetch origin --tags
test "$(git rev-parse HEAD)" = "$(git rev-parse 'vX.Y.Z-rc.N^{commit}')"
bunx changeset pre exit
git add .changeset/pre.json
git commit -m "chore: promote X.Y.Z RC to stable"
git push origin release/X.Y.Z-rc
```

Run the commands sequentially; stop if the cutoff check fails. This commit only
records exit intent. The bot prepares a stable version PR against the same RC
branch. Before versioning, automation requires the branch's files to match a
tagged RC except for `.changeset/pre.json`. The PR removes prerelease state and
produces stable versions, dependencies, changelogs, and the refreshed lockfile.
It does not need a new changeset just to promote the RC.

Freeze source changes on the RC branch until promotion is complete. Review the
stable PR against the selected RC, confirm only release metadata changed, and
merge after checks pass. Follow **Tag And Publish** with `vX.Y.Z`, without marking
it as a prerelease. The release skills follow this version PR flow by default;
their explicit local fallback also supports rehearsals directly at the RC cutoff.
Both paths use the same cutoff validator, which allows release metadata commits
and PR merges after the selected RC while preserving its source.

After publishing, open a separate PR merging the stable release history into
current `master`. Use a merge commit to preserve ancestry. Preserve newer source
changes and pending changesets while bringing in released versions, dependencies,
changelogs, and consumed changeset removal. Refresh `bun.lock`, then verify a
frozen install, build, and typecheck. Keep the existing stable tag unchanged.

## Tag And Publish

Tag the exact merged release commit, even if the branch has advanced since the
PR merged. Use the version shown in the release files:

```bash
git fetch origin --tags
git tag vX.Y.Z <merged-release-commit-sha>
git push origin refs/tags/vX.Y.Z
```

For an RC, substitute `vX.Y.Z-rc.N`. Create a GitHub Release for the existing tag:
mark RC releases as **prerelease**, and stable releases as stable. The existing
`.github/workflows/publish.yml` validates and publishes that tagged commit.

Stable packages go to npm's `latest` dist-tag. RCs explicitly use `rc`. The RC
publisher removes `.changeset/pre.json` only in its CI checkout before running
`bunx changeset publish --tag rc`; Changesets disallows `--tag` while prerelease
state is present. This avoids relying on implicit prerelease dist-tag selection.

Verify npm after publishing succeeds:

```bash
npm view @cashu/coco-core dist-tags
npm view @cashu/coco-core@latest version
npm view @cashu/coco-core@rc version
```

Consumers can install an RC with `npm install @cashu/coco-core@rc`.

## Local Preparation And Recovery

To prepare release files locally instead of using the bot, start from a clean
release branch with the appropriate prerelease state, install dependencies, then
run:

```bash
RELEASE_BRANCH="$(git branch --show-current)" bun run release:version
bun install --frozen-lockfile
bun run build
bun run typecheck
git diff
```

Review and commit `.changeset/`, changed package manifests and changelogs, and
`bun.lock` before following **Tag And Publish**. Do not merge a stale bot PR after
preparing the same release locally.

If versions, changelogs, or tags are wrong, fix them before publishing the GitHub
Release. For an unpushed local release tag, correct the commit and retag locally.
For a pushed tag, coordinate with maintainers before moving or replacing it.

If npm publishing fails, fix the condition on a new commit, create a new tag, and
publish a new GitHub Release. Do not reuse a tag for a different package artifact
after npm has accepted any package from that tag.
