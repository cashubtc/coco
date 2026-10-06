import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'node_modules/@changesets/cli/bin.js');
const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, path: string, value: unknown) {
  writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
}

function read(dir: string, path: string) {
  return JSON.parse(readFileSync(join(dir, path), 'utf8'));
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'coco-release-test-'));
  workspaces.push(dir);
  mkdirSync(join(dir, '.changeset'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  write(dir, 'package.json', {
    name: 'release-fixture',
    private: true,
    workspaces: ['packages/*'],
  });
  write(dir, '.changeset/config.json', {
    changelog: '@changesets/cli/changelog',
    commit: false,
    fixed: [['@cashu/coco-core', '@cashu/coco-react']],
    linked: [],
    access: 'public',
    baseBranch: 'master',
    updateInternalDependencies: 'patch',
    ignore: ['@cashu/coco-fountain'],
  });
  for (const [name, version] of [
    ['core', '2.0.0'],
    ['react', '2.0.0'],
    ['fountain', '0.0.0'],
  ]) {
    mkdirSync(join(dir, 'packages', name!), { recursive: true });
    write(dir, `packages/${name}/package.json`, {
      name: `@cashu/coco-${name}`,
      version,
      ...(name === 'react' ? { peerDependencies: { '@cashu/coco-core': '2.0.0' } } : {}),
    });
    write(dir, `packages/${name}/CHANGELOG.md`, `# Changes\n\n## ${version}\n`);
  }
  write(dir, '.changeset/core.md', "---\n'@cashu/coco-core': patch\n---\n\nCore change.\n");
  write(
    dir,
    '.changeset/fountain.md',
    "---\n'@cashu/coco-fountain': minor\n---\n\nFountain change.\n",
  );
  return dir;
}

function run(dir: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bun', script, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      RELEASE_TAG: '',
      GITHUB_REF_NAME: '',
      RELEASE_PRERELEASE: '',
      PRERELEASE_TAG: 'rc',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

function succeeds(result: ReturnType<typeof run>) {
  expect(result.output).not.toContain('error');
  expect(result.code).toBe(0);
}

test('core versioning leaves fountain versions and pending changesets untouched', () => {
  const dir = workspace();
  succeeds(run(dir, join(root, 'scripts/version-core.ts')));
  expect(read(dir, 'packages/core/package.json').version).toBe('2.0.1');
  expect(read(dir, 'packages/react/package.json').version).toBe('2.0.1');
  expect(read(dir, 'packages/fountain/package.json').version).toBe('0.0.0');
  expect(existsSync(join(dir, '.changeset/fountain.md'))).toBe(true);
  expect(existsSync(join(dir, '.changeset/core.md'))).toBe(false);
});

test('core RC entry, follow-up, and exit preserve an unreleased fountain package', () => {
  const dir = workspace();
  rmSync(join(dir, 'packages/fountain/CHANGELOG.md'));
  succeeds(run(dir, cli, ['pre', 'enter', 'rc']));
  succeeds(run(dir, join(root, 'scripts/version-core.ts')));
  expect(read(dir, 'packages/core/package.json').version).toBe('2.0.1-rc.0');
  succeeds(
    run(dir, join(root, 'scripts/check-release.ts'), [], {
      RELEASE_TAG: 'v2.0.1-rc.0',
      RELEASE_PRERELEASE: 'true',
    }),
  );
  succeeds(run(dir, join(root, 'scripts/version-core.ts')));
  succeeds(run(dir, cli, ['pre', 'exit']));
  succeeds(run(dir, join(root, 'scripts/version-core.ts')));
  expect(read(dir, 'packages/core/package.json').version).toBe('2.0.1');
  expect(read(dir, 'packages/fountain/package.json').version).toBe('0.0.0');
  expect(existsSync(join(dir, 'packages/fountain/CHANGELOG.md'))).toBe(false);
  expect(existsSync(join(dir, '.changeset/fountain.md'))).toBe(true);
}, 20_000);

test('core RC publication selects only core and retains pre state until the publish step', () => {
  const dir = workspace();
  succeeds(run(dir, cli, ['pre', 'enter', 'rc']));
  succeeds(run(dir, join(root, 'scripts/version-core.ts')));
  succeeds(
    run(dir, join(root, 'scripts/prepare-publish.ts'), [], {
      RELEASE_TAG: 'v2.0.1-rc.0',
      RELEASE_PRERELEASE: 'true',
    }),
  );
  expect(read(dir, 'packages/fountain/package.json').private).toBe(true);
  expect(read(dir, 'packages/core/package.json').private).toBeUndefined();
  expect(read(dir, '.changeset/pre.json').mode).toBe('pre');
});

test('fountain versioning consumes only its changesets and restores the normal configuration', () => {
  const dir = workspace();
  const config = readFileSync(join(dir, '.changeset/config.json'), 'utf8');
  succeeds(run(dir, join(root, 'scripts/version-fountain.ts')));
  expect(read(dir, 'packages/fountain/package.json').version).toBe('0.1.0');
  expect(read(dir, 'packages/core/package.json').version).toBe('2.0.0');
  expect(read(dir, 'packages/react/package.json').version).toBe('2.0.0');
  expect(existsSync(join(dir, '.changeset/core.md'))).toBe(true);
  expect(existsSync(join(dir, '.changeset/fountain.md'))).toBe(false);
  expect(readFileSync(join(dir, '.changeset/config.json'), 'utf8')).toBe(config);
});

test('mixed-scope changesets fail without leaving fountain selected', () => {
  const dir = workspace();
  const config = readFileSync(join(dir, '.changeset/config.json'), 'utf8');
  write(
    dir,
    '.changeset/mixed.md',
    "---\n'@cashu/coco-core': patch\n'@cashu/coco-fountain': patch\n---\n\nMixed.\n",
  );
  expect(run(dir, join(root, 'scripts/version-fountain.ts')).code).not.toBe(0);
  expect(readFileSync(join(dir, '.changeset/config.json'), 'utf8')).toBe(config);
  expect(read(dir, 'packages/fountain/package.json').version).toBe('0.0.0');
});

test('fountain versioning refuses core prerelease mode', () => {
  const dir = workspace();
  succeeds(run(dir, cli, ['pre', 'enter', 'rc']));
  const result = run(dir, join(root, 'scripts/version-fountain.ts'));
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('outside Changesets prerelease mode');
});

for (const [tag, selected] of [
  ['v2.0.0', ['core', 'react']],
  ['coco-fountain-v0.0.0', ['fountain']],
] as const) {
  test(`${tag} validates and makes only its selected packages publishable`, () => {
    const dir = workspace();
    const env = { RELEASE_TAG: tag, RELEASE_PRERELEASE: 'false' };
    succeeds(run(dir, join(root, 'scripts/prepare-publish.ts'), [], env));
    for (const name of ['core', 'react', 'fountain']) {
      expect(read(dir, `packages/${name}/package.json`).private === true).toBe(
        !selected.some((value) => value === name),
      );
    }
  });
}

test('a rejected tag or mismatched changelog cannot change publication scope', () => {
  const dir = workspace();
  for (const tag of [
    'v0.0.0',
    'coco-fountain-v2.0.0',
    'coco-fountain-v0.0.0-rc.0',
    'unrecognized',
  ]) {
    expect(
      run(dir, join(root, 'scripts/prepare-publish.ts'), [], { RELEASE_TAG: tag }).code,
    ).not.toBe(0);
  }
  write(dir, 'packages/fountain/CHANGELOG.md', '# Changes\n\n## 9.9.9\n');
  expect(
    run(dir, join(root, 'scripts/prepare-publish.ts'), [], { RELEASE_TAG: 'coco-fountain-v0.0.0' })
      .code,
  ).not.toBe(0);
  for (const name of ['core', 'react', 'fountain']) {
    expect(read(dir, `packages/${name}/package.json`).private).toBeUndefined();
  }
});
