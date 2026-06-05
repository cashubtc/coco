import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type PackageJson = {
  private?: boolean;
  name?: string;
  version?: string | null;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const prereleaseTag = process.env.PRERELEASE_TAG ?? 'rc';
const npmViewTimeoutMs = Number(process.env.NPM_VIEW_TIMEOUT_MS ?? '10000');
const versionPattern = new RegExp(`^(\\d+\\.\\d+\\.\\d+)-${prereleaseTag}\\.(\\d+)$`);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageJsonPaths(): string[] {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'package.json'))
    .filter((path) => existsSync(path));
}

function npmVersions(packageName: string): string[] {
  try {
    const stdout = execFileSync('npm', ['view', packageName, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: npmViewTimeoutMs,
    }).trim();

    if (!stdout) {
      return [];
    }

    const versions = JSON.parse(stdout) as string | string[];
    return Array.isArray(versions) ? versions : [versions];
  } catch (error) {
    const { stderr } = error as { stderr?: Buffer | string };
    const errorOutput = String(stderr ?? '');

    if (errorOutput.includes('E404') || errorOutput.includes('404')) {
      return [];
    }

    throw error;
  }
}

const packages = packageJsonPaths().map((path) => ({
  path,
  json: readJson<PackageJson>(path),
}));
const publishablePackages = packages.filter(
  ({ json }) => !json.private && json.name && typeof json.version === 'string',
);

if (publishablePackages.length === 0) {
  throw new Error('No publishable packages found');
}

const generatedVersions = publishablePackages.map(({ json }) => {
  const match = json.version?.match(versionPattern);

  if (!match) {
    throw new Error(`${json.name} version ${json.version} is not an ${prereleaseTag} version`);
  }

  return {
    baseVersion: match[1],
    rcNumber: Number(match[2]),
  };
});

const [firstVersion] = generatedVersions;

if (!firstVersion) {
  throw new Error('No generated versions found');
}

for (const version of generatedVersions) {
  if (
    version.baseVersion !== firstVersion.baseVersion ||
    version.rcNumber !== firstVersion.rcNumber
  ) {
    throw new Error('Publishable packages must share the same generated RC version');
  }
}

let latestPublishedRc = -1;

for (const { json } of publishablePackages) {
  const versions = npmVersions(json.name!);

  for (const version of versions) {
    const match = version.match(versionPattern);

    if (match && match[1] === firstVersion.baseVersion) {
      latestPublishedRc = Math.max(latestPublishedRc, Number(match[2]));
    }
  }
}

const nextRc = latestPublishedRc + 1;
const generatedVersion = `${firstVersion.baseVersion}-${prereleaseTag}.${firstVersion.rcNumber}`;
const nextVersion = `${firstVersion.baseVersion}-${prereleaseTag}.${nextRc}`;

function updateDependencyVersion(dependencyVersion: string): string {
  for (const prefix of ['', '^', '~']) {
    if (dependencyVersion === `${prefix}${generatedVersion}`) {
      return `${prefix}${nextVersion}`;
    }
  }

  return dependencyVersion;
}

for (const { path, json } of publishablePackages) {
  json.version = nextVersion;

  for (const dependencySet of [
    json.dependencies,
    json.devDependencies,
    json.peerDependencies,
    json.optionalDependencies,
  ]) {
    if (!dependencySet) {
      continue;
    }

    for (const [dependencyName, dependencyVersion] of Object.entries(dependencySet)) {
      dependencySet[dependencyName] = updateDependencyVersion(dependencyVersion);
    }
  }

  writeJson(path, json);
}

console.log(`Prepared ${nextVersion} for npm dist-tag ${prereleaseTag}`);
