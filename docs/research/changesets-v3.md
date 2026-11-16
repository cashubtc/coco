# Changesets v3 migration

Assessed and rehearsed on 2026-11-16, starting from coco commit
`8fd97f3857a744a9f053a0886d71c5f31c38f70f`.

## Decision and implementation

Upgrade the root CLI dependency from `^2.29.8` (locked to 2.29.8) to `^3.0.3`
(locked to 3.0.3). npm's registry `dist-tags` response and the
[official release](https://github.com/changesets/changesets/releases/tag/%40changesets%2Fcli%403.0.3)
both identify 3.0.3 as latest. That patch includes a fix for bounded internal
dependency ranges.

Preserve private-package versioning explicitly:

```json
"privatePackages": { "version": true, "tag": false }
```

Keep `ignore: ["cocod"]`. Private SQL storage shares pending changesets with public
packages; with v3 defaults, the actual checkout fails planning with
`Found mixed changeset atomic-key-allocation`. Enabling private versioning fixes
that failure. SQL storage remains private; it is not published or tagged.
See [configuration](../../.changeset/config.json) and the
[mixed changeset](../../.changeset/atomic-key-allocation.md).

Keep the seven-public-package fixed group, explicit `master` base branch,
`public` access, built-in changelog generator and tag-triggered publish workflow.
The root has no custom Changesets library imports to migrate. No application
package versions or pending changesets are changed by this tooling PR.

## Changes that affect maintainers

V3 stops versioning private packages by default, changes peer-dependent bump
propagation from major to patch, and moves consumed prerelease changesets into
`.changeset/pre/`. `changeset status` migrates old prerelease state and therefore
can write files. Empty stable `version` runs now return exit code 1.
Source: [migration guide](https://changesets.dev/guide/migration).

[RELEASING.md](../../RELEASING.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), and
the [RC](../../.agents/skills/cut-rc-release/SKILL.md) and
[stable](../../.agents/skills/cut-stable-release/SKILL.md) skills now describe the
toolchain requirements, RC history, migration timing and no-change RC behavior.

Upgrade before starting an RC cycle. An existing v2 RC branch can migrate, but
qualify the upgraded toolchain with a new RC before selecting the stable cutoff.
The existing [cutoff guard](../../.agents/skills/cut-stable-release/scripts/check-stable-cutoff.sh)
permits release metadata only; root dependency/lockfile upgrades do not belong in
stable finalization.

The RC skill's old no-change exception was removed: an actual v3 run with only
historical prerelease entries succeeded but did not advance the version.
New RCs need new changesets. Existing `git add .changeset` includes the nested
history, and the stable cutoff guard accepts its deletion during finalization.

## Bun, Node and publishing

Changesets v3 supports Node `^22.11 || ^24 || >=26` and npm `>=10.9.0`.
Its ESM CLI does not require changing the root package's module type.
Sources: [migration requirements](https://changesets.dev/guide/migration#install-requirements),
[tagged CLI manifest](https://github.com/changesets/changesets/blob/%40changesets%2Fcli%403.0.3/packages/cli/package.json).

Publishing CI already selects Node 24 and Bun 1.3.11. Local defaults were Node
22.22.1, npm 9.2.0 and Bun 1.3.14. Rehearsals used Node 22.22.1 plus isolated npm 11.21.2
and Bun 1.3.11 under `/tmp`; global tools were not changed. npm trusted publishing
requires npm 11.5.1+ and Node 22.14.0+.
Source: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

`bunx changeset` respects the CLI's Node shebang. V3 selects npm for publishing
this Bun workspace; the intercepted-command rehearsal confirmed this.
Sources: [Bun shebang behavior](https://bun.sh/docs/pm/bunx#shebangs),
[publish-tool selection](https://github.com/changesets/changesets/blob/%40changesets%2Fcli%403.0.3/packages/cli/src/commands/publish/getPublishTool.ts).

Retain the RC publishing preparation: validate committed prerelease state, remove
only `pre.json` in the CI checkout, then pass `--tag rc`. V3 still rejects an
explicit tag in active prerelease mode, and its implicit selection can choose
`latest` for prerelease-only npm history. The new `pre/` folder can stay.
Sources: [publish precondition](https://github.com/changesets/changesets/blob/%40changesets%2Fcli%403.0.3/packages/cli/src/commands/publish/index.ts),
[tag selection](https://github.com/changesets/changesets/blob/%40changesets%2Fcli%403.0.3/packages/cli/src/commands/publish-plan/getPublishPlan.ts).

## Executed verification

Versioning used independent disposable repositories containing this checkout's
tracked source, manifests, changesets, upgraded configuration and lockfile.
They had local Git history for changelog generation and no configured remotes.
The generated 3.0.0 application versions below result from existing major
changesets; they are test outputs, not a release cut.

- **Private policy:** v3 `status` failed on mixed private/public changesets without
  the opt-in and succeeded with it. SQL storage was versioned; cocod stayed
  0.0.17 and docs stayed unversioned.
- **Direct stable:** `changeset version` produced 3.0.0 for all seven public
  packages. The existing `scripts/check-release.ts` passed, covering versions,
  exact/caret internal ranges and changelog headings. A second version command
  returned exit code 1.
- **Patch/minor propagation:** replacing the pending changesets in separate
  fixtures with one core patch or minor produced aligned public versions 2.0.1
  and 2.1.0 respectively. The release validator and frozen installs passed for
  both, exercising the peer behavior without accumulated major changes masking it.
- **RC lifecycle:** `pre enter rc` then `version` produced 3.0.0-rc.0. Every
  consumed changeset moved into `pre/`. A no-change run retained the version.
  Adding a core patch changeset produced 3.0.0-rc.1. `pre exit` then `version`
  produced 3.0.0, removed prerelease state/history and retained both original
  entries and the follow-up marker in the stable changelog. The release
  validator passed at each stage; the stable cutoff guard passed.
- **V2 migration:** an isolated CLI 2.29.8 generated real v2 RC state from these
  manifests. V3 `status` moved every recorded changeset, reduced `pre.json` to
  mode/tag, preserved new pending work and made no further changes on its second
  invocation. Follow-up RC and stable finalization passed the release validator.
- **Lockfile:** `bun install --frozen-lockfile` passed after each versioning stage;
  byte comparisons confirmed that the lockfile did not change.
- **Publish boundary:** a local executable intercepted every npm command and
  never forwarded it to npm or the network. Changesets requested exactly the seven
  public packages, public access and `latest` for stable; after CI-style
  preparation it requested `rc` for RCs with history still present. Publishing
  with active pre-state and an explicit tag failed before any npm call.
  `--no-git-tag` prevented tag creation in this fixture.
- **Repository checks:** `bun run security:release-age` passed for 1,161 locked npm
  versions, with two configured exclusions. `bun run build` and
  `bun run typecheck` passed using Bun 1.3.11.
- **Versioned artifacts:** `bun run build` also passed in the disposable stable
  3.0.0 repository. `npm pack --dry-run --ignore-scripts --json` passed for all
  seven public packages, each containing its manifest and built `dist/` files.

The temporary rehearsal harnesses assert these outcomes and retain logs under
`/tmp/coco-changesets-*.log` in the implementation environment. They are manual
migration evidence, not a new CI test suite.

## Remaining production validation

No registry upload occurred. The command interceptor proves command selection,
access, package selection and requested tags; it does not exercise npm lifecycle
scripts or OIDC authorization. Actual trusted-publisher authentication and
registry-side dist-tags remain checks for the normal publish workflow and its
post-publish verification, especially for a first-ever package publication.

No wallet runtime or storage contracts changed, so no mint integration tests or
package release changeset were added.
