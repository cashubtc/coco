import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const script = join(repo, 'scripts/prepare-nightly.ts');
const directories: string[] = [];

type TestManifest = {
  version: string;
  private?: boolean;
  peerDependencies: Record<string, string>;
  publishConfig?: { tag: string };
};

function command(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env };
  // Fixture commits are intentionally different from a GitHub Actions checkout.
  delete env.GITHUB_SHA;
  Object.assign(env, extraEnv);
  return Bun.spawnSync(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
}

function successful(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = command(cwd, args, env);
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.toString().trim();
}

function fixture(empty = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'coco-nightly-test-'));
  directories.push(cwd);
  for (const file of ['package.json', 'bun.lock', '.changeset']) {
    cpSync(join(repo, file), join(cwd, file), { recursive: true });
  }
  if (empty) {
    for (const file of readdirSync(join(cwd, '.changeset'))) {
      if (file.endsWith('.md') && file !== 'README.md') rmSync(join(cwd, '.changeset', file));
    }
  }
  for (const name of readdirSync(join(repo, 'packages'))) {
    const source = join(repo, 'packages', name);
    if (!existsSync(join(source, 'package.json'))) continue;
    const target = join(cwd, 'packages', name);
    mkdirSync(target, { recursive: true });
    for (const file of ['package.json', 'CHANGELOG.md']) {
      if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file));
    }
  }
  writeFileSync(join(cwd, 'packages/core/source.ts'), 'export const unchanged = true;\n');
  successful(cwd, ['git', 'init', '-q']);
  successful(cwd, ['git', 'add', 'package.json', 'bun.lock', '.changeset', 'packages']);
  successful(
    cwd,
    [
      'git',
      '-c',
      'user.name=Nightly test',
      '-c',
      'user.email=nightly@example.invalid',
      'commit',
      '-qm',
      'Fixture',
    ],
    {
      GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
      GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
    },
  );
  symlinkSync(join(repo, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  return cwd;
}

function manifest(cwd: string, name: string) {
  return JSON.parse(
    readFileSync(join(cwd, 'packages', name, 'package.json'), 'utf8'),
  ) as TestManifest;
}

function editJson(cwd: string, path: string, edit: (value: TestManifest) => void) {
  const file = join(cwd, path);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  edit(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function prepare(cwd: string) {
  successful(cwd, ['bun', script, 'prepare']);
  successful(cwd, ['bun', script, 'check']);
  return manifest(cwd, 'core').version;
}

afterEach(() => {
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('nightly release preparation with the installed Changesets CLI', () => {
  test('keeps public packages and peers aligned without changing source or the eventual stable release', () => {
    const cwd = fixture();
    const sha = successful(cwd, ['git', 'rev-parse', 'HEAD']);
    const version = prepare(cwd);
    expect(version).toBe(`0.0.0-nightly-20260102030405-${sha.slice(0, 7)}`);
    const publicNames = [
      'core',
      'react',
      'indexeddb',
      'sqlite3',
      'sqlite-bun',
      'expo-sqlite',
      'adapter-tests',
    ];
    for (const name of publicNames) expect(manifest(cwd, name).version).toBe(version);
    expect(manifest(cwd, 'adapter-tests').peerDependencies['@cashu/coco-core']).toBe(version);
    expect(manifest(cwd, 'sql-storage').private).toBe(true);
    expect(manifest(cwd, 'cocod')).toEqual(manifest(repo, 'cocod'));
    expect(readFileSync(join(cwd, 'packages/core/source.ts'), 'utf8')).toBe(
      'export const unchanged = true;\n',
    );

    // Returning to the source commit restores all changesets and changelogs. No nightly
    // metadata is needed by, or leaks into, the eventual normal release.
    successful(cwd, ['git', 'reset', '--hard', 'HEAD']);
    successful(cwd, ['bunx', '--no-install', 'changeset', 'version']);
    const stableVersion = manifest(cwd, 'core').version;
    expect(stableVersion).toMatch(/^\d+\.\d+\.\d+$/);
    successful(cwd, ['bun', join(repo, 'scripts/check-release.ts')], {
      RELEASE_TAG: `v${stableVersion}`,
      RELEASE_PRERELEASE: 'false',
    });
    expect(readFileSync(join(cwd, 'packages/core/CHANGELOG.md'), 'utf8')).not.toContain(
      'Temporary nightly snapshot',
    );
  }, 30_000);

  test('versions an empty changeset queue and reuses the same version when retried', () => {
    const cwd = fixture(true);
    const version = prepare(cwd);
    successful(cwd, ['git', 'reset', '--hard', 'HEAD']);
    expect(prepare(cwd)).toBe(version);
  }, 30_000);

  test('rejects RC state before modifying release metadata', () => {
    const cwd = fixture(true);
    successful(cwd, ['bunx', '--no-install', 'changeset', 'pre', 'enter', 'rc']);
    const before = readFileSync(join(cwd, 'packages/core/package.json'), 'utf8');
    const result = command(cwd, ['bun', script, 'prepare']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('without RC state');
    expect(readFileSync(join(cwd, 'packages/core/package.json'), 'utf8')).toBe(before);
    expect(existsSync(join(cwd, '.changeset/nightly-snapshot.md'))).toBe(false);
  });

  test('rejects a public package outside the fixed group', () => {
    const cwd = fixture(true);
    const path = join(cwd, 'packages/extra/package.json');
    mkdirSync(dirname(path));
    writeFileSync(path, JSON.stringify({ name: '@cashu/coco-extra', version: '2.0.0' }));
    const result = command(cwd, ['bun', script, 'prepare']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('single Changesets fixed group');
  });

  test('rejects stable versions and non-exact internal peer dependencies before publishing', () => {
    const cwd = fixture(true);
    const version = prepare(cwd);
    editJson(cwd, 'packages/react/package.json', (pkg) => {
      pkg.version = '2.0.0';
    });
    let result = command(cwd, ['bun', script, 'check']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('must have nightly version');
    editJson(cwd, 'packages/react/package.json', (pkg) => {
      pkg.version = version;
      pkg.peerDependencies['@cashu/coco-core'] = `^${version}`;
    });
    result = command(cwd, ['bun', script, 'check']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('must be exactly');
  }, 30_000);

  test('rejects a package that overrides the npm channel', () => {
    const cwd = fixture(true);
    editJson(cwd, 'packages/core/package.json', (pkg) => {
      pkg.publishConfig = { tag: 'latest' };
    });
    const result = command(cwd, ['bun', script, 'prepare']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('overrides the nightly npm tag');
  });

  test('rejects a checkout that differs from the GitHub Actions commit', () => {
    const cwd = fixture(true);
    const result = command(cwd, ['bun', script, 'prepare'], { GITHUB_SHA: '0'.repeat(40) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('commit selected by GitHub Actions');
    expect(existsSync(join(cwd, '.changeset/nightly-snapshot.md'))).toBe(false);
  });

  test('the publishing gate permits current master, skips stale commits, and fails on lookup errors', () => {
    const cwd = fixture(true);
    const sha = successful(cwd, ['git', 'rev-parse', 'HEAD']);
    successful(cwd, ['git', 'update-ref', 'refs/heads/master', sha]);
    successful(cwd, ['git', 'remote', 'add', 'origin', join(cwd, '.git')]);
    const workflow = Bun.YAML.parse(
      readFileSync(join(repo, '.github/workflows/publish.yml'), 'utf8'),
    ) as { jobs: Record<string, { steps: { id?: string; shell?: string; run?: string }[] }> };
    const gate = workflow.jobs['publish-nightly']!.steps.find((step) => step.id === 'current')!;
    expect(gate.shell).toBe('bash');
    const gateScript = join(cwd, 'check-master.sh');
    writeFileSync(gateScript, gate.run!);
    const output = join(cwd, 'output');
    const summary = join(cwd, 'summary');
    const args = ['bash', '--noprofile', '--norc', '-eo', 'pipefail', gateScript];
    const env = { EXPECTED_SHA: sha, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
    successful(cwd, args, env);
    expect(readFileSync(output, 'utf8')).toBe('publish=true\n');
    writeFileSync(output, '');
    successful(cwd, args, { ...env, EXPECTED_SHA: '0'.repeat(40) });
    expect(readFileSync(output, 'utf8')).toBe('');
    expect(readFileSync(summary, 'utf8')).toContain('Skipping superseded commit');
    successful(cwd, ['git', 'remote', 'remove', 'origin']);
    expect(command(cwd, args, env).exitCode).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('');
  });
});
