import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FOUNTAIN_PACKAGE, readReleasePackages } from './release-packages';

// Fountain's independent 0.x releases are prepared outside core's RC cycle.
if (existsSync('.changeset/pre.json')) {
  throw new Error('Version fountain from a checkout outside Changesets prerelease mode');
}
const packages = readReleasePackages();
if (!packages.some(({ json }) => json.name === FOUNTAIN_PACKAGE)) {
  throw new Error('Missing fountain package');
}
const path = '.changeset/config.json';
const original = readFileSync(path, 'utf8');
const config = JSON.parse(original);
config.ignore = packages.map(({ json }) => json.name).filter((name) => name !== FOUNTAIN_PACKAGE);

try {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const result = Bun.spawnSync(
    ['bun', new URL('../node_modules/@changesets/cli/bin.js', import.meta.url).pathname, 'version'],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) throw new Error('Fountain versioning failed');
} finally {
  writeFileSync(path, original);
}
