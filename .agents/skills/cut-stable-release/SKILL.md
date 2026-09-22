---
name: cut-stable-release
description: Promote a selected coco RC to stable through a version PR, or resume tagging its merged commit. Also handles explicitly requested direct stable releases from master and local dry runs or manual fallback.
---

# Cut Stable Release

Promote the selected RC on `release/X.Y.Z-rc`, preserving its source while
`master` advances. For RC versions, use `$cut-rc-release`.

## Route The Request

Default to stable promotion from an RC. Use the **Stable Releases From Master**
path in [RELEASING.md](../../../RELEASING.md) only when the user requests a direct
stable release; then follow the shared finish procedure without an RC cutoff.

For a dry run, preview, rehearsal, or explicitly requested local fallback, read
[Local preparation](../../../docs/agents/release-skills.md#local-preparation)
instead. Both paths end at a pushed tag, or a local tag for a dry run; GitHub
Release publication is a separate action.

Read `RELEASING.md` for setup and current release commands. Work in a clean
dedicated release worktree; preserve unrelated changes using a separate worktree.

## Prepare Or Resume Promotion

1. **Record the cutoff.** Fetch the RC branch and tags. Record `RELEASE_BRANCH`,
   `RC_CUTOFF_TAG`, and its peeled commit SHA as `RC_CUTOFF_COMMIT`. Use the RC
   selected by the user, or identify the tagged RC at branch HEAD when none was
   specified. For a resumed promotion, recover the cutoff from task/PR context or
   the matching reachable RC tag; clarify only if the selection remains ambiguous.
   Keep this exact cutoff throughout the task. Done when a tagged RC
   in the intended version series is selected.

2. **Inspect promotion state.** If a stable version PR is already open or merged,
   resume it against the recorded cutoff. If `pre.json` already has mode `exit`,
   resume the bot workflow. For a new promotion, require branch HEAD to equal
   `RC_CUTOFF_COMMIT`, then follow **Promote A Selected RC To Stable** in
   `RELEASING.md` to commit and push exit intent. Source changes after the selected
   RC require another RC. Done when exit intent is committed or an existing stable
   candidate is identified.

3. **Review the stable version PR.** Use the PR from
   `changeset-release/<RELEASE_BRANCH>` into the same RC branch. Check the stable
   version matches the cutoff's release series, prerelease state is removed,
   and versions, dependencies, changelogs, and lockfile are updated. No new
   changeset is needed solely for promotion. Record the PR head as
   `RELEASE_COMMIT` and validate it with the cutoff helper below. Review manifest
   and lockfile changes for release-version and internal-dependency bookkeeping;
   runtime settings or external dependency changes require another RC. Done when the proposed stable commit passes release
   checks and preserves the selected cutoff.

4. **Finish the release.** Follow
   [Finish a version PR](../../../docs/agents/release-skills.md#finish-a-version-pr).
   Recheck the actual merged commit against `RC_CUTOFF_COMMIT` before tagging.
   Report the separate back-merge into `master` as remaining work; perform it
   only when covered by the user's request. Use the merge-commit procedure in
   `RELEASING.md` to retain release ancestry.

## Validate The Selected Cutoff

Run this skill's helper from the candidate worktree:

```bash
.agents/skills/cut-stable-release/scripts/check-stable-cutoff.sh \
  "$RC_CUTOFF_COMMIT" "$RELEASE_COMMIT"
```

The helper shares the automation's validator: the selected cutoff must be an
ancestor and only permitted release files may differ, including `bun.lock`.
Exit-intent commits and PR merges are allowed. For local uncommitted release
files, omit the candidate argument to compare the worktree instead.

At the validated candidate, run `scripts/derive-stable-release-metadata.sh` from
this skill directory. Record `NEW_PACKAGE_VERSION` and `NEW_RELEASE_TAG`; for
promotion, require `RC_CUTOFF_TAG` to match `${NEW_RELEASE_TAG}-rc.N`.
