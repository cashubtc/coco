#!/usr/bin/env bun

const DEFAULT_BUNFIG_PATH = 'bunfig.toml';
const DEFAULT_LOCKFILE_PATH = 'bun.lock';
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
const DEFAULT_CONCURRENCY = 24;
const MAX_DISPLAYED_FAILURES = 25;

type ReleaseAgeConfig = {
  minimumReleaseAgeSeconds: number;
  excludes: Set<string>;
};

type LockedPackage = {
  name: string;
  version: string;
  line: number;
};

type RegistryMetadata = {
  time?: Record<string, unknown>;
};

type CheckedPackage = LockedPackage & {
  publishedAt?: Date;
  ageSeconds?: number;
  warning?: string;
};

type FailedPackage = CheckedPackage & {
  publishedAt: Date;
  ageSeconds: number;
};

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function usage(): string {
  return [
    'Usage: bun scripts/check-release-age.ts [--config=path] [--lockfile=path]',
    '',
    'Checks bun.lock against the minimumReleaseAge configured in bunfig.toml.',
    'Set NPM_REGISTRY_URL to use a registry other than https://registry.npmjs.org.',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readReleaseAgeConfig(configPath: string): Promise<ReleaseAgeConfig> {
  const text = await Bun.file(configPath).text();
  const parsed = Bun.TOML.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} does not contain a TOML object`);
  }

  const install = parsed.install;
  if (!isRecord(install)) {
    throw new Error(`${configPath} must define [install].minimumReleaseAge`);
  }

  const minimumReleaseAge = install.minimumReleaseAge;
  if (
    typeof minimumReleaseAge !== 'number' ||
    !Number.isFinite(minimumReleaseAge) ||
    minimumReleaseAge <= 0
  ) {
    throw new Error(`${configPath} must define a positive numeric [install].minimumReleaseAge`);
  }

  const excludes = install.minimumReleaseAgeExcludes;
  if (
    excludes !== undefined &&
    (!Array.isArray(excludes) || excludes.some((name) => typeof name !== 'string'))
  ) {
    throw new Error(
      `${configPath} [install].minimumReleaseAgeExcludes must be an array of strings`,
    );
  }

  return {
    minimumReleaseAgeSeconds: minimumReleaseAge,
    excludes: new Set(excludes as string[] | undefined),
  };
}

function parsePackageSpec(spec: string): { name: string; version: string } | null {
  const aliasMarker = '@npm:';
  const aliasIndex = spec.lastIndexOf(aliasMarker);
  const packageSpec = aliasIndex === -1 ? spec : spec.slice(aliasIndex + aliasMarker.length);
  const versionSeparator = packageSpec.lastIndexOf('@');

  if (versionSeparator <= 0 || versionSeparator === packageSpec.length - 1) {
    return null;
  }

  const name = packageSpec.slice(0, versionSeparator);
  const version = packageSpec.slice(versionSeparator + 1);
  if (name.includes(':') || version.includes(':')) {
    return null;
  }

  return { name, version };
}

type JsonPosition = {
  index: number;
  line: number;
};

type JsonStringToken = JsonPosition & {
  value: string;
};

function readJsonStringToken(text: string, startIndex: number, line: number): JsonStringToken {
  let index = startIndex + 1;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (char === '"' && !escaped) {
      return {
        value: JSON.parse(text.slice(startIndex, index + 1)) as string,
        index: index + 1,
        line,
      };
    }

    escaped = char === '\\' && !escaped;
    if (char !== '\\') {
      escaped = false;
    }
    index += 1;
  }

  throw new Error('Unterminated string in bun.lock');
}

function skipJsonWhitespaceAndComments(text: string, position: JsonPosition): JsonPosition {
  let { index, line } = position;

  while (index < text.length) {
    const char = text[index];
    if (char === '\n') {
      index += 1;
      line += 1;
      continue;
    }
    if (char === ' ' || char === '\r' || char === '\t') {
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') {
          line += 1;
        }
        index += 1;
      }
      index += 2;
      continue;
    }

    break;
  }

  return { index, line };
}

function findPackagesObject(text: string): JsonPosition {
  let position: JsonPosition = { index: 0, line: 1 };
  let objectDepth = 0;

  while (position.index < text.length) {
    position = skipJsonWhitespaceAndComments(text, position);
    const char = text[position.index];

    if (char === '"') {
      const key = readJsonStringToken(text, position.index, position.line);
      if (objectDepth === 1 && key.value === 'packages') {
        let afterKey = skipJsonWhitespaceAndComments(text, key);
        if (text[afterKey.index] === ':') {
          afterKey = skipJsonWhitespaceAndComments(text, {
            index: afterKey.index + 1,
            line: afterKey.line,
          });
          if (text[afterKey.index] === '{') {
            return afterKey;
          }
        }
      }

      position = key;
      continue;
    }

    if (char === '{') {
      objectDepth += 1;
    } else if (char === '}') {
      objectDepth -= 1;
    } else if (char === '\n') {
      position.line += 1;
    }
    position.index += 1;
  }

  return { index: -1, line: 1 };
}

function readLockPackageLines(lockfileText: string): Map<string, number> {
  const packageLines = new Map<string, number>();
  let position = findPackagesObject(lockfileText);
  if (position.index === -1) {
    return packageLines;
  }

  let objectDepth = 1;
  position = { index: position.index + 1, line: position.line };

  while (position.index < lockfileText.length && objectDepth > 0) {
    position = skipJsonWhitespaceAndComments(lockfileText, position);
    const char = lockfileText[position.index];

    if (char === '"') {
      const key = readJsonStringToken(lockfileText, position.index, position.line);
      if (objectDepth === 1) {
        const afterKey = skipJsonWhitespaceAndComments(lockfileText, key);
        if (lockfileText[afterKey.index] === ':') {
          packageLines.set(key.value, position.line);
        }
      }
      position = key;
      continue;
    }

    if (char === '{') {
      objectDepth += 1;
    } else if (char === '}') {
      objectDepth -= 1;
    } else if (char === '\n') {
      position.line += 1;
    }
    position.index += 1;
  }

  return packageLines;
}

async function readLockedPackages(lockfilePath: string): Promise<LockedPackage[]> {
  const text = await Bun.file(lockfilePath).text();
  const parsedLockfile = Bun.JSONC.parse(text);
  if (!isRecord(parsedLockfile)) {
    throw new Error(`${lockfilePath} does not contain a JSONC object`);
  }

  const lockfilePackages = parsedLockfile.packages;
  if (!isRecord(lockfilePackages)) {
    throw new Error(`${lockfilePath} must define a packages object`);
  }

  const packages = new Map<string, LockedPackage>();
  const packageLines = readLockPackageLines(text);

  for (const [packageKey, packageEntry] of Object.entries(lockfilePackages)) {
    if (!Array.isArray(packageEntry) || typeof packageEntry[0] !== 'string') {
      throw new Error(
        `${lockfilePath}:${packageLines.get(packageKey) ?? 1} has an invalid package entry`,
      );
    }

    const spec = packageEntry[0];
    const parsed = parsePackageSpec(spec);
    if (!parsed) continue;

    const key = `${parsed.name}@${parsed.version}`;
    if (!packages.has(key)) {
      packages.set(key, {
        ...parsed,
        line: packageLines.get(packageKey) ?? 1,
      });
    }
  }

  if (packages.size === 0) {
    throw new Error(`No npm package entries were found in ${lockfilePath}`);
  }

  return [...packages.values()].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName === 0 ? a.version.localeCompare(b.version) : byName;
  });
}

function packageMetadataUrl(registryUrl: string, name: string): string {
  const registry = registryUrl.replace(/\/+$/, '');
  return `${registry}/${encodeURIComponent(name)}`;
}

async function fetchRegistryMetadata(name: string, registryUrl: string): Promise<RegistryMetadata> {
  const url = packageMetadataUrl(registryUrl, name);
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        const metadata = await response.json();
        if (!isRecord(metadata)) {
          throw new Error(`Registry response for ${name} was not an object`);
        }
        return metadata as RegistryMetadata;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) {
        throw new Error(`Registry returned ${response.status} for ${name}`);
      }

      lastError = new Error(`Registry returned ${response.status} for ${name}`);
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }

    await Bun.sleep(attempt * 1_000);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && minutes > 0) parts.push(`${minutes}m`);
  return parts.length === 0 ? `${seconds}s` : parts.join(' ');
}

function getPublishedAt(pkg: LockedPackage, metadata: RegistryMetadata): Date | undefined {
  const publishedAt = metadata.time?.[pkg.version];
  if (typeof publishedAt !== 'string') return undefined;

  const date = new Date(publishedAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function groupByPackageName(packages: LockedPackage[]): Map<string, LockedPackage[]> {
  const packagesByName = new Map<string, LockedPackage[]>();
  for (const pkg of packages) {
    const versions = packagesByName.get(pkg.name);
    if (versions) {
      versions.push(pkg);
    } else {
      packagesByName.set(pkg.name, [pkg]);
    }
  }
  return packagesByName;
}

async function checkPackages(
  packages: LockedPackage[],
  registryUrl: string,
  now: Date,
): Promise<CheckedPackage[]> {
  const packagesByName = groupByPackageName(packages);
  const checkedGroups = await mapConcurrent(
    [...packagesByName.entries()],
    DEFAULT_CONCURRENCY,
    async ([name, versions]) => {
      const metadata = await fetchRegistryMetadata(name, registryUrl);

      return versions.map((pkg): CheckedPackage => {
        const publishedAt = getPublishedAt(pkg, metadata);
        if (!publishedAt) {
          return {
            ...pkg,
            warning: `No publish time found for ${pkg.name}@${pkg.version}; treating as allowed`,
          };
        }

        return {
          ...pkg,
          publishedAt,
          ageSeconds: (now.getTime() - publishedAt.getTime()) / 1_000,
        };
      });
    },
  );

  return checkedGroups.flat();
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  const configPath = readArg('--config') ?? DEFAULT_BUNFIG_PATH;
  const lockfilePath = readArg('--lockfile') ?? DEFAULT_LOCKFILE_PATH;
  const registryUrl = process.env.NPM_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const config = await readReleaseAgeConfig(configPath);
  const lockedPackages = await readLockedPackages(lockfilePath);
  const packagesToCheck = lockedPackages.filter((pkg) => !config.excludes.has(pkg.name));
  const checkedPackages = await checkPackages(packagesToCheck, registryUrl, new Date());
  const failures = checkedPackages
    .filter(
      (pkg): pkg is FailedPackage =>
        pkg.publishedAt !== undefined &&
        pkg.ageSeconds !== undefined &&
        pkg.ageSeconds < config.minimumReleaseAgeSeconds,
    )
    .sort((a, b) => a.ageSeconds - b.ageSeconds);
  const warnings = checkedPackages.filter((pkg) => pkg.warning);

  for (const warning of warnings) {
    console.warn(`warning: ${warning.warning}`);
  }

  if (failures.length > 0) {
    const threshold = formatDuration(config.minimumReleaseAgeSeconds);
    console.error(
      `Dependency release age check failed: ${failures.length} locked package version(s) ` +
        `are newer than ${threshold}.`,
    );

    for (const pkg of failures.slice(0, MAX_DISPLAYED_FAILURES)) {
      const age = formatDuration(pkg.ageSeconds);
      console.error(
        `  - ${pkg.name}@${pkg.version} published ${pkg.publishedAt.toISOString()} ` +
          `(${age} old, ${lockfilePath}:${pkg.line})`,
      );
    }

    if (failures.length > MAX_DISPLAYED_FAILURES) {
      console.error(`  ...and ${failures.length - MAX_DISPLAYED_FAILURES} more`);
    }

    process.exit(1);
  }

  const excludedCount = lockedPackages.length - packagesToCheck.length;
  const threshold = formatDuration(config.minimumReleaseAgeSeconds);
  const suffix = excludedCount === 0 ? '' : ` (${excludedCount} excluded by bunfig.toml)`;
  console.log(
    `Checked ${packagesToCheck.length} locked npm package version(s) against ` +
      `${threshold} minimum release age${suffix}.`,
  );
}

main().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(normalized.message);
  process.exit(1);
});
