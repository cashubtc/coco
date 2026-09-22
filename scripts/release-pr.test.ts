import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePrEnabled } from './release-pr.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = join(repository, 'scripts/release-pr.ts');
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function command(directory: string, args: string[], branch = 'master', success = true) {
  const result = Bun.spawnSync(args, {
    cwd: directory,
    env: { ...process.env, RELEASE_BRANCH: branch, CI: 'true' },
  });
  const output = result.stdout.toString() + result.stderr.toString();
  if (success && result.exitCode !== 0) throw new Error(output);
  if (!success) expect(result.exitCode).not.toBe(0);
  return output;
}

function writeJson(directory: string, path: string, value: unknown) {
  writeFileSync(join(directory, path), JSON.stringify(value, null, 2) + '\n');
}

function readJson(directory: string, path: string) {
  return JSON.parse(readFileSync(join(directory, path), 'utf8'));
}

function commit(directory: string) {
  command(directory, ['git', 'add', '.']);
  command(directory, ['git', 'commit', '-m', 'fixture']);
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coco-release-pr-'));
  fixtures.push(directory);
  mkdirSync(join(directory, '.changeset'));
  writeJson(directory, 'package.json', {
    name: 'release-test',
    private: true,
    workspaces: ['packages/*'],
  });
  writeJson(directory, '.changeset/config.json', {
    changelog: '@changesets/cli/changelog',
    commit: false,
    fixed: [['@fixture/core', '@fixture/react']],
    linked: [],
    access: 'public',
    baseBranch: 'master',
    updateInternalDependencies: 'patch',
    ignore: [],
  });
  for (const name of ['core', 'react']) {
    mkdirSync(join(directory, 'packages', name), { recursive: true });
    writeJson(directory, `packages/${name}/package.json`, {
      name: `@fixture/${name}`,
      version: '1.0.0',
      ...(name === 'react' ? { peerDependencies: { '@fixture/core': '1.0.0' } } : {}),
    });
    writeFileSync(join(directory, `packages/${name}/index.ts`), 'export const value = 1;\n');
  }
  writeFileSync(
    join(directory, '.changeset/first.md'),
    '---\n"@fixture/core": major\n---\n\nAdd a breaking feature.\n',
  );
  writeFileSync(join(directory, '.gitignore'), 'node_modules\n');
  symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
  command(directory, ['git', 'init', '-b', 'master']);
  command(directory, ['git', 'config', 'user.name', 'Release test']);
  command(directory, ['git', 'config', 'user.email', 'release-test@example.invalid']);
  command(directory, ['git', 'config', 'commit.gpgsign', 'false']);
  commit(directory);
  return directory;
}

function version(directory: string, branch = 'master', success = true) {
  return command(directory, [process.execPath, script, 'version'], branch, success);
}

function frozenInstall(directory: string) {
  const lockfile = readFileSync(join(directory, 'bun.lock'), 'utf8');
  // Do not let installation alter the real workspace's linked node_modules.
  unlinkSync(join(directory, 'node_modules'));
  command(directory, [process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts']);
  expect(readFileSync(join(directory, 'bun.lock'), 'utf8')).toBe(lockfile);
}

test('only enables master and RC branches that explicitly entered pre or exit mode', () => {
  expect(releasePrEnabled('master')).toBe(true);
  expect(releasePrEnabled('release/2.0.0-rc')).toBe(false);
  expect(releasePrEnabled('release/2.0.0-rc', { mode: 'pre', tag: 'rc' })).toBe(true);
  expect(releasePrEnabled('release/2.0.0-rc', { mode: 'exit', tag: 'rc' })).toBe(true);
  expect(() => releasePrEnabled('master', { mode: 'pre', tag: 'rc' })).toThrow('master');
  expect(() => releasePrEnabled('release/2.0.0-rc', { mode: 'pre', tag: 'beta' })).toThrow(
    'tag rc',
  );
  expect(() => releasePrEnabled('feature/test')).toThrow('Unsupported');
});

test('versions a stable fixed group, updates dependencies, and produces a frozen-installable lockfile', () => {
  const directory = fixture();
  version(directory);
  expect(readJson(directory, 'packages/core/package.json').version).toBe('2.0.0');
  expect(readJson(directory, 'packages/react/package.json').peerDependencies['@fixture/core']).toBe(
    '2.0.0',
  );
  expect(readFileSync(join(directory, 'packages/core/CHANGELOG.md'), 'utf8')).toContain('## 2.0.0');
  frozenInstall(directory);
  command(directory, [process.execPath, script, 'check']);
}, 30_000);

test('versions successive RCs and promotes the tagged cutoff without requiring a new changeset', () => {
  const directory = fixture();
  const branch = 'release/2.0.0-rc';
  command(directory, ['git', 'switch', '-c', branch]);
  command(directory, ['bunx', 'changeset', 'pre', 'enter', 'rc']);
  commit(directory);
  version(directory, branch);
  expect(readJson(directory, 'packages/core/package.json').version).toBe('2.0.0-rc.0');
  expect(readJson(directory, '.changeset/pre.json').mode).toBe('pre');
  commit(directory);
  command(directory, ['git', 'tag', 'v2.0.0-rc.0']);

  writeFileSync(
    join(directory, '.changeset/fix.md'),
    '---\n"@fixture/core": patch\n---\n\nFix the feature.\n',
  );
  commit(directory);
  version(directory, branch);
  expect(readJson(directory, 'packages/core/package.json').version).toBe('2.0.0-rc.1');
  expect(readJson(directory, 'packages/react/package.json').peerDependencies['@fixture/core']).toBe(
    '2.0.0-rc.1',
  );
  commit(directory);
  command(directory, ['git', 'tag', 'v2.0.0-rc.1']);

  command(directory, ['bunx', 'changeset', 'pre', 'exit']);
  commit(directory);
  version(directory, branch);
  expect(readJson(directory, 'packages/core/package.json').version).toBe('2.0.0');
  expect(readFileSync(join(directory, 'packages/core/index.ts'), 'utf8')).toBe(
    'export const value = 1;\n',
  );
  command(directory, [process.execPath, script, 'check'], branch);
  frozenInstall(directory);
  expect(command(directory, [process.execPath, script, 'status'], branch)).toContain('inactive');
  writeFileSync(join(directory, 'packages/core/index.ts'), 'export const value = 2;\n');
  expect(command(directory, [process.execPath, script, 'check'], branch, false)).toContain(
    'cut another RC',
  );
}, 30_000);

test('rejects a generated RC outside the branch release series', () => {
  const directory = fixture();
  command(directory, ['bunx', 'changeset', 'pre', 'enter', 'rc']);
  expect(version(directory, 'release/3.0.0-rc', false)).toContain('does not match release branch');
}, 30_000);

test('requires another tagged RC when source changes after the selected cutoff', () => {
  const directory = fixture();
  const branch = 'release/2.0.0-rc';
  command(directory, ['bunx', 'changeset', 'pre', 'enter', 'rc']);
  version(directory, branch);
  commit(directory);
  command(directory, ['git', 'tag', 'v2.0.0-rc.0']);
  writeFileSync(join(directory, 'packages/core/index.ts'), 'export const value = 2;\n');
  command(directory, ['bunx', 'changeset', 'pre', 'exit']);
  commit(directory);
  expect(version(directory, branch, false)).toContain('cut another RC');
  expect(readJson(directory, 'packages/core/package.json').version).toBe('2.0.0-rc.0');
}, 30_000);

test('the skill cutoff helper accepts metadata PR merges and checks the selected ancestor', () => {
  const directory = fixture();
  const helper = join(
    repository,
    '.agents/skills/cut-stable-release/scripts/check-stable-cutoff.sh',
  );
  const cutoff = command(directory, ['git', 'rev-parse', 'HEAD']).trim();
  writeJson(directory, '.changeset/pre.json', { mode: 'exit', tag: 'rc' });
  commit(directory);
  command(directory, ['git', 'switch', '-c', 'stable-version-pr']);
  writeJson(directory, 'packages/core/package.json', { name: '@fixture/core', version: '2.0.0' });
  writeFileSync(join(directory, 'bun.lock'), '{}\n');
  rmSync(join(directory, '.changeset/pre.json'));
  commit(directory);
  command(directory, ['git', 'switch', 'master']);
  command(directory, [
    'git',
    'merge',
    '--no-ff',
    'stable-version-pr',
    '-m',
    'Merge stable version PR',
  ]);

  const check = (candidate: string, success = true) =>
    command(directory, ['bash', helper, cutoff, candidate, directory], 'master', success);
  expect(check('HEAD')).toContain('only release metadata');
  expect(check(cutoff, false)).toContain('no release metadata changes');
  expect(check('')).toContain('only release metadata');

  // Named candidates are checked independently of unrelated worktree edits.
  writeFileSync(join(directory, 'packages/core/index.ts'), 'export const value = 2;\n');
  expect(check('', false)).toContain('cut another RC');
  expect(check('HEAD')).toContain('only release metadata');
  commit(directory);
  expect(check('HEAD', false)).toContain('cut another RC');

  const tree = command(directory, ['git', 'rev-parse', `${cutoff}^{tree}`]).trim();
  const unrelated = command(directory, [
    'git',
    'commit-tree',
    tree,
    '-m',
    'Unrelated history',
  ]).trim();
  expect(check(unrelated, false)).toContain('must be an ancestor');
});
