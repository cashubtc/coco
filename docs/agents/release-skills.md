# Release Skill Procedures

Shared steps for `cut-rc-release` and `cut-stable-release`. Operational release
commands and repository setup live in [RELEASING.md](../../RELEASING.md); version
and cutoff rules live in `scripts/release-pr.ts` and `scripts/check-release.ts`.

## Finish A Version PR

1. **Identify the candidate.** Record the version PR URL, base branch, head SHA,
   and intended version. Require its base to be `RELEASE_BRANCH` and its head to
   be `changeset-release/<RELEASE_BRANCH>`. Inspect the diff and check results for
   that exact head SHA. If the PR is already merged, obtain its `mergeCommit.oid`
   and continue at step 3. Done when the release candidate is unambiguous.

2. **Complete review and merge.** Proceed within the user's requested scope and
   the repository's required reviews and checks. Approve bot workflow runs when
   authorized and needed. Merge only the reviewed head SHA, using the repository's
   supported merge method. If preparation alone was requested, or a required
   review or check remains pending, report the concrete PR and remaining step;
   the release has not been cut. Done when GitHub reports the PR merged.

3. **Validate the merged commit.** Fetch and record the PR's actual merge commit
   as `RELEASE_COMMIT`. Inspect it in the dedicated worktree, even if the release
   branch has advanced. Verify it is an ancestor of that remote release branch.
   Derive release metadata using the invoking skill's helper. For stable
   promotion, also run its cutoff helper with the recorded `RC_CUTOFF_COMMIT` and
   `RELEASE_COMMIT`. Run:

   ```bash
   RELEASE_BRANCH="$RELEASE_BRANCH" bun scripts/release-pr.ts check
   bun install --frozen-lockfile
   bun run build
   bun run typecheck
   ```

   Confirm these commands leave tracked files unchanged. Done when the exact
   commit to be tagged passes validation, including cutoff preservation when
   applicable. A failed merged candidate needs correction and review before
   tagging; report the failure rather than generating another version silently.

4. **Tag the validated commit.** Create `NEW_RELEASE_TAG` at `RELEASE_COMMIT` and
   push that tag. If the tag already exists locally or remotely, require its
   peeled commit to equal `RELEASE_COMMIT`; reuse a matching tag and stop on a
   mismatch. The PR has already updated the release branch, so only the tag needs
   pushing. Done when the remote tag resolves to the validated commit.

5. **Report the result.** Include the PR, package version, tag, commit, release
   branch, and push status. For stable promotion include the cutoff and back-merge
   status. These skills end at the tag: publishing npm packages or creating a
   GitHub Release requires a separate explicit instruction. If that instruction
   is already present in the session, continue within it using `RELEASING.md`.

## Local Preparation

Use this path only for an explicit local fallback or a dry run, preview, or
rehearsal. A dry run creates local release files, a commit, and a tag without
pushing, merging PRs, or dispatching remote automation.

1. **Select an isolated starting point.** Record the intended `RELEASE_BRANCH`;
   use a disposable clone for dry runs so rehearsal tags remain isolated (Git
   worktrees share tags). For a live local fallback, use a clean dedicated
   worktree. For an RC, use the intended source cutoff or
   follow-up changes on its RC branch. For stable promotion, record the selected
   RC tag and `RC_CUTOFF_COMMIT`, and start exactly there. Use `master` only for an
   explicitly requested direct stable release. Inspect existing version PRs so
   the same release is not later merged twice. Done when branch, source, and
   requested version are established.

2. **Prepare release state.** Install with the frozen lockfile. For a first RC,
   enter `rc` prerelease mode; for a follow-up retain its committed state and
   identify unconsumed package changesets as described in the RC skill. For stable
   promotion, run `bunx changeset pre exit` locally at the cutoff. Direct stable
   releases require pending package changesets and no prerelease state. Done when
   Changesets state matches the requested release kind.

3. **Generate once and validate.** Run
   `RELEASE_BRANCH="$RELEASE_BRANCH" bun run release:version`, then derive metadata
   using the invoking skill's helper. Confirm the generated version matches the
   request. Run the frozen install, build, and typecheck from the shared finish
   procedure. For stable promotion run the cutoff helper without a candidate ref
   to check uncommitted files. Done when the generated release passes all checks.

4. **Commit release files.** Review the diff, then stage only Changesets metadata,
   changed package manifests and changelogs, and `bun.lock`. Commit and record its
   SHA as `RELEASE_COMMIT`. For promotion, recheck that commit against the selected
   cutoff. Tag this commit, applying the matching-tag rule from the shared finish
   procedure. Done when the local release commit and tag are valid.

5. **Finish according to mode.** For a dry run, report the clone location and local artifacts,
   then stop. For an authorized local release, push the commit to `RELEASE_BRANCH` and
   its tag atomically without force. Reconcile any superseded bot PR; leave it
   unmerged and close it when authorized. Report the shared release result and
   remaining publication/back-merge work. Done when the requested local or remote
   tag exists at the validated commit.
