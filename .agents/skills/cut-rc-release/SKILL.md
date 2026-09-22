---
name: cut-rc-release
description: Cut a first or follow-up coco RC through a release-branch version PR, or resume tagging its merged commit. Use for RC release requests; use the local path for explicit dry runs or manual fallback.
---

# Cut RC Release

Prepare an RC on `release/X.Y.Z-rc` and tag the validated release commit. For
stable promotion, use `$cut-stable-release`.

## Route The Request

Use the bot version PR flow below by default. For a dry run, preview, rehearsal,
or explicitly requested local fallback, read
[Local preparation](../../../docs/agents/release-skills.md#local-preparation)
instead. Both paths end at a pushed tag, or a local tag for a dry run; GitHub
Release publication is a separate action.

Read [RELEASING.md](../../../RELEASING.md) for repository setup and the current
release commands. Work in a clean dedicated release worktree; preserve unrelated
changes by using a separate worktree.

## Prepare Or Resume The RC

1. **Identify the release.** Record `RELEASE_BRANCH` and the intended version
   series from the request and pending changesets. Inspect remote state and any
   existing version PR before changing files. A branch name does not select the
   Changesets version. Done when the requested RC cycle and its current state
   are known.

2. **Choose the starting point.** For a first RC with no existing branch, create it from the
   intended `master` cutoff and follow **Start An RC Cycle** in `RELEASING.md`.
   Push the committed prerelease intent so the bot can prepare the version PR.
   For a follow-up, use the existing RC branch with only the intended fixes and
   their changesets. Preserve its prerelease state. Done when the branch has
   `.changeset/pre.json` in `pre` mode with tag `rc`.

3. **Find unconsumed work.** Changesets CLI v2 keeps consumed RC changeset files;
   exclude IDs recorded in `pre.json.changesets` and ignore empty changesets when
   deciding whether another RC is due. If no unconsumed package changesets remain,
   look for the requested release's already-merged version PR and resume tagging
   it. A new no-change RC requires an explicit request and the local path. Done
   when either new release work or an existing release commit is identified. If
   neither exists, report that there is no RC to cut and leave the branch unchanged.

4. **Use the version PR.** Locate the PR from
   `changeset-release/<RELEASE_BRANCH>` into `RELEASE_BRANCH`. Use **Prepare
   release PR** on that branch to retry a failed run after fixing its cause.
   Review versions, changelogs, dependencies, prerelease state, and lockfile;
   require the RC series to match the branch. Continue with
   [Finish a version PR](../../../docs/agents/release-skills.md#finish-a-version-pr).
   Versioning is already done by the bot; tag its merged commit without running
   `changeset version` again.

## Derive RC Metadata

At the candidate release commit, run
`scripts/derive-rc-release-metadata.sh` from this skill directory. Record its
`NEW_PACKAGE_VERSION`, `NEW_RELEASE_TAG`, and `RELEASE_BRANCH`; the derived branch
must equal the intended branch recorded above. The shared finish procedure then
validates and tags that exact commit.
