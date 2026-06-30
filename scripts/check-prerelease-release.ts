import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function packageJsonPaths(): string[] {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => join('packages', entry.name, 'package.json'))
    .filter((path) => existsSync(path));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExpectedDependencyVersion(version: string, expectedVersion: string): boolean {
  return (
    version === expectedVersion ||
    version === `^${expectedVersion}` ||
    version === `~${expectedVersion}`
  );
}

const versionPattern = new RegExp(`^\\d+\\.\\d+\\.\\d+-${escapeRegExp(prereleaseTag)}\\.\\d+$`);

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

const invalidVersions = publishablePackages.filter(
  ({ json }) => !versionPattern.test(json.version!),
);

if (invalidVersions.length > 0) {
  const details = invalidVersions.map(({ json }) => `  - ${json.name}@${json.version}`).join('\n');
  throw new Error(
    `Publishable packages must be committed with ${prereleaseTag} prerelease versions:\n${details}`,
  );
}

const expectedVersion = publishablePackages[0]?.json.version;

if (!expectedVersion) {
  throw new Error('No prerelease version found');
}

const mismatchedVersions = publishablePackages.filter(
  ({ json }) => json.version !== expectedVersion,
);

if (mismatchedVersions.length > 0) {
  const details = publishablePackages
    .map(({ json }) => `  - ${json.name}@${json.version}`)
    .join('\n');
  throw new Error(`Publishable packages must share the same prerelease version:\n${details}`);
}

const publishablePackageNames = new Set(publishablePackages.map(({ json }) => json.name!));
const mismatchedDependencies: string[] = [];

for (const { json } of publishablePackages) {
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
      if (
        publishablePackageNames.has(dependencyName) &&
        !isExpectedDependencyVersion(dependencyVersion, expectedVersion)
      ) {
        mismatchedDependencies.push(
          `  - ${json.name} depends on ${dependencyName}@${dependencyVersion}`,
        );
      }
    }
  }
}

if (mismatchedDependencies.length > 0) {
  throw new Error(
    `Published package dependencies must reference ${expectedVersion}:\n${mismatchedDependencies.join(
      '\n',
    )}`,
  );
}

console.log(`Verified ${publishablePackages.length} packages for npm dist-tag ${prereleaseTag}`);
