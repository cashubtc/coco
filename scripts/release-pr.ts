import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PreState = { mode?: string; tag?: string };

const root = process.cwd();
const checkReleaseScript = fileURLToPath(new URL('./check-release.ts', import.meta.url));

function readPreState(): PreState | undefined {
  const path = resolve(root, '.changeset/pre.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function rcVersion(branch: string): string | undefined {
  if (branch === 'master') return undefined;
  const match = /^release\/(\d+\.\d+\.\d+)-rc$/.exec(branch);
  if (!match) throw new Error(`Unsupported release branch: ${branch}`);
  return match[1];
}

export function releasePrEnabled(branch: string, preState?: PreState): boolean {
  const target = rcVersion(branch);
  if (!target) {
    if (preState) throw new Error('master must not be in Changesets prerelease mode');
    return true;
  }
  // A newly created RC branch has not opted in; a finalized branch is retired.
  if (!preState) return false;
  if (preState.tag !== 'rc' || !['pre', 'exit'].includes(preState.mode ?? '')) {
    throw new Error(`${branch} requires Changesets pre or exit mode with tag rc`);
  }
  return true;
}

function run(command: string[], env: Record<string, string> = {}): void {
  const result = Bun.spawnSync(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${command.join(' ')}`);
}

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function checkPromotionCutoff(target: string, versioned = false): void {
  const cutoff = git(['describe', '--tags', '--match', `v${target}-rc.*`, '--abbrev=0', 'HEAD']);
  if (!new RegExp(`^v${target.replaceAll('.', '\\.')}-rc\\.\\d+$`).test(cutoff)) {
    throw new Error(`Invalid RC cutoff tag: ${cutoff}`);
  }
  checkStableCutoff(cutoff, undefined, versioned);
}

function checkStableCutoff(cutoff: string, candidate?: string, versioned = true): void {
  const cutoffCommit = git(['rev-parse', '--verify', `${cutoff}^{commit}`]);
  const candidateCommit = git(['rev-parse', '--verify', `${candidate || 'HEAD'}^{commit}`]);
  const ancestry = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', cutoffCommit, candidateCommit],
    {
      cwd: root,
    },
  );
  if (ancestry.exitCode !== 0) {
    throw new Error(`Selected RC cutoff ${cutoff} must be an ancestor of the stable candidate`);
  }
  // An omitted candidate includes staged and unstaged local release files.
  const revisions = candidate ? [cutoffCommit, candidateCommit] : [cutoffCommit];
  const changed = git(['diff', '--name-only', ...revisions, '--'])
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0) throw new Error('Stable candidate has no release metadata changes');
  // Before versioning, only exit intent may differ; afterward allow release files.
  const allowed = versioned
    ? /^(?:\.changeset\/[^/]+|packages\/[^/]+\/(?:package\.json|CHANGELOG\.md)|bun\.lock)$/
    : /^\.changeset\/pre\.json$/;
  if (changed.some((path) => !allowed.test(path))) {
    throw new Error(`Stable promotion must preserve ${cutoff}; cut another RC for new changes`);
  }
  console.log(
    `Verified stable candidate changes only release metadata after cutoff ${cutoffCommit}`,
  );
}

function checkVersion(branch: string): void {
  const { version } = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'));
  const match = /^(\d+\.\d+\.\d+)(-rc\.\d+)?$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  const target = rcVersion(branch);
  if (target ? match[1] !== target : match[2]) {
    throw new Error(`Generated version ${version} does not match release branch ${branch}`);
  }
  if (target && !match[2]) checkPromotionCutoff(target, true);
  run([process.execPath, checkReleaseScript], {
    RELEASE_TAG: `v${version}`,
    RELEASE_PRERELEASE: String(Boolean(match[2])),
    PRERELEASE_TAG: 'rc',
  });
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'cutoff') {
    const cutoff = process.argv[3];
    if (!cutoff)
      throw new Error('Usage: bun scripts/release-pr.ts cutoff <cutoff-ref> [candidate-ref]');
    checkStableCutoff(cutoff, process.argv[4] || undefined);
    process.exit(0);
  }
  const branch = process.env.RELEASE_BRANCH;
  if (!branch) throw new Error('Set RELEASE_BRANCH to master or release/X.Y.Z-rc');
  if (command === 'status') {
    const enabled = releasePrEnabled(branch, readPreState());
    console.log(`Release PR automation for ${branch}: ${enabled ? 'enabled' : 'inactive'}`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
    }
  } else if (command === 'version') {
    const preState = readPreState();
    if (!releasePrEnabled(branch, preState)) throw new Error(`${branch} is not in prerelease mode`);
    if (preState?.mode === 'exit') checkPromotionCutoff(rcVersion(branch)!);
    run(['bunx', 'changeset', 'version']);
    checkVersion(branch);
    run([process.execPath, 'install', '--lockfile-only', '--ignore-scripts']);
  } else if (command === 'check') {
    checkVersion(branch);
  } else {
    throw new Error('Usage: bun scripts/release-pr.ts <status|version|check|cutoff>');
  }
}
