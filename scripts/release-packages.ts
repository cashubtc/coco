import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FOUNTAIN_PACKAGE = '@cashu/coco-fountain';

export type PackageJson = {
  private?: boolean;
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** Read workspace manifests without importing package code or resolving built exports. */
export function readReleasePackages() {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'package.json'))
    .filter((path) => existsSync(path))
    .sort()
    .map((path) => ({ path, json: JSON.parse(readFileSync(path, 'utf8')) as PackageJson }));
}

/** Select an explicit publication scope from the GitHub Release tag. */
export function selectRelease(tag: string) {
  const match = /^(coco-fountain-v|v)(.+)$/.exec(tag);
  if (!match) throw new Error('Release tag must start with v or coco-fountain-v');
  const scope = match[1] === 'v' ? 'core' : 'fountain';
  const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8')) as {
    fixed: string[][];
  };
  const coreNames = new Set(config.fixed.flat());
  if (coreNames.has(FOUNTAIN_PACKAGE)) {
    throw new Error('Fountain must not belong to the core fixed release group');
  }
  const names = scope === 'core' ? coreNames : new Set([FOUNTAIN_PACKAGE]);
  const packages = readReleasePackages();
  const publicPackages = packages.filter(({ json }) => !json.private && json.version);
  for (const { json } of publicPackages) {
    if (!coreNames.has(json.name) && json.name !== FOUNTAIN_PACKAGE) {
      throw new Error(`No release scope registered for ${json.name}`);
    }
  }
  const selected = publicPackages.filter(({ json }) => names.has(json.name));
  if (!names.size || selected.length !== names.size) {
    throw new Error(`Missing publishable packages for ${scope} release`);
  }
  return { scope, version: match[2]!, packages, selected };
}
