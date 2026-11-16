import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Manifest = {
  name: string;
  version?: string | null;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  publishConfig?: { tag?: string };
};

function run(command: string[]): string {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function readPackages() {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'package.json'))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest }))
    .filter(({ manifest }) => !manifest.private);
}

// Run only in a disposable checkout: Changesets consumes pending release metadata here.
function main() {
  const mode = process.argv[2];
  if (mode !== 'prepare' && mode !== 'check') {
    throw new Error('Usage: bun scripts/prepare-nightly.ts <prepare|check>');
  }
  if (existsSync('.changeset/pre.json') || existsSync('.changeset/pre')) {
    throw new Error('Nightly snapshots require a checkout without RC state');
  }

  const sha = run(['git', 'rev-parse', 'HEAD']);
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) {
    throw new Error('Checkout must match the commit selected by GitHub Actions');
  }
  // A rerun of the same commit must reuse its version, including after a partial publish.
  const timestamp = new Date(Number(run(['git', 'show', '-s', '--format=%ct', 'HEAD'])) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace(/\D/g, '');
  const version = `0.0.0-nightly-${timestamp}-${sha.slice(0, 7)}`;
  const packages = readPackages();
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8')) as {
    fixed?: string[][];
    snapshot?: { useCalculatedVersion?: boolean };
  };
  const group = config.fixed?.[0];
  if (
    !group?.length ||
    config.fixed?.length !== 1 ||
    group.length !== names.size ||
    new Set(group).size !== names.size ||
    !group.every((name) => names.has(name))
  ) {
    throw new Error('Every public package must belong to the single Changesets fixed group');
  }
  if (config.snapshot?.useCalculatedVersion) {
    throw new Error('Nightly snapshots must use the 0.0.0 base version');
  }
  for (const { manifest } of packages) {
    if (manifest.publishConfig?.tag && manifest.publishConfig.tag !== 'nightly') {
      throw new Error(`${manifest.name} overrides the nightly npm tag`);
    }
  }

  if (mode === 'prepare') {
    // Ensure even docs-only commits and commits just after a release produce a snapshot.
    writeFileSync(
      '.changeset/nightly-snapshot.md',
      `---\n${[...names]
        .sort()
        .map((name) => `${JSON.stringify(name)}: patch`)
        .join('\n')}\n---\n\nTemporary nightly snapshot.\n`,
      { flag: 'wx' },
    );
    console.log(
      run([
        'bunx',
        '--no-install',
        'changeset',
        'version',
        '--snapshot',
        'nightly',
        '--snapshot-prerelease-template',
        `{tag}-${timestamp}-{commit-short}`,
      ]),
    );
  }

  for (const { manifest } of readPackages()) {
    if (manifest.version !== version) {
      throw new Error(
        `${manifest.name} must have nightly version ${version}, got ${manifest.version}`,
      );
    }
    for (const kind of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const) {
      for (const [name, range] of Object.entries(manifest[kind] ?? {})) {
        if (names.has(name) && range !== version) {
          throw new Error(
            `${manifest.name} ${kind}.${name} must be exactly ${version}, got ${range}`,
          );
        }
      }
    }
  }
  console.log(`Verified ${packages.length} nightly packages at ${version}`);
}

main();
