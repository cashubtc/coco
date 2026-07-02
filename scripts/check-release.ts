import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type PackageJson = {
  private?: boolean;
  name?: string;
  version?: string | null;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type ReleaseKind = 'stable' | 'prerelease';

const prereleaseTag = process.env.PRERELEASE_TAG ?? 'rc';
const releaseTag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
const releasePrerelease = parseOptionalBoolean(process.env.RELEASE_PRERELEASE);

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

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`Expected RELEASE_PRERELEASE to be "true" or "false", got "${value}"`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function releaseKind(version: string): ReleaseKind | null {
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return 'stable';
  }

  const prereleasePattern = new RegExp(
    `^\\d+\\.\\d+\\.\\d+-${escapeRegExp(prereleaseTag)}\\.\\d+$`,
  );

  return prereleasePattern.test(version) ? 'prerelease' : null;
}

function isExpectedDependencyVersion(version: string, expectedVersion: string): boolean {
  return (
    version === expectedVersion ||
    version === `^${expectedVersion}` ||
    version === `~${expectedVersion}`
  );
}

function latestChangelogVersion(changelogPath: string): string | null {
  if (!existsSync(changelogPath)) {
    return null;
  }

  const changelog = readFileSync(changelogPath, 'utf8');
  const match = changelog.match(/^##\s+(.+?)\s*$/m);
  return match?.[1] ?? null;
}

if (!releaseTag) {
  throw new Error('RELEASE_TAG or GITHUB_REF_NAME must be set to the GitHub Release tag');
}

const releaseTagMatch = releaseTag.match(/^v(.+)$/);

if (!releaseTagMatch) {
  throw new Error(`Release tag must start with "v", got "${releaseTag}"`);
}

const expectedVersion = releaseTagMatch[1]!;
const expectedReleaseKind = releaseKind(expectedVersion);

if (!expectedReleaseKind) {
  throw new Error(`Release tag ${releaseTag} must be vX.Y.Z or vX.Y.Z-${prereleaseTag}.N`);
}

if (releasePrerelease === true && expectedReleaseKind !== 'prerelease') {
  throw new Error(`GitHub prereleases must use vX.Y.Z-${prereleaseTag}.N tags`);
}

if (releasePrerelease === false && expectedReleaseKind !== 'stable') {
  throw new Error(`Stable GitHub releases must use vX.Y.Z tags`);
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

const mismatchedVersions = publishablePackages.filter(
  ({ json }) => json.version !== expectedVersion,
);

if (mismatchedVersions.length > 0) {
  const details = mismatchedVersions
    .map(({ json }) => `  - ${json.name}@${json.version}`)
    .join('\n');
  throw new Error(`Publishable package versions must match ${releaseTag}:\n${details}`);
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

const mismatchedChangelogs = publishablePackages.flatMap(({ path, json }) => {
  const changelogPath = join(dirname(path), 'CHANGELOG.md');
  const version = latestChangelogVersion(changelogPath);

  if (version === expectedVersion) {
    return [];
  }

  return [`  - ${json.name} has ${changelogPath} latest version ${version ?? '<missing>'}`];
});

if (mismatchedChangelogs.length > 0) {
  throw new Error(
    `Publishable package changelogs must start with ${expectedVersion}:\n${mismatchedChangelogs.join(
      '\n',
    )}`,
  );
}

console.log(
  `Verified ${publishablePackages.length} packages for ${releaseTag} (${expectedReleaseKind})`,
);
