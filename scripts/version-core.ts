import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FOUNTAIN_PACKAGE, readReleasePackages } from './release-packages';

const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));
if (!config.ignore.includes(FOUNTAIN_PACKAGE)) {
  throw new Error('Core versioning requires fountain to be ignored in Changesets config');
}
const fountain = readReleasePackages().find(({ json }) => json.name === FOUNTAIN_PACKAGE);
if (!fountain) throw new Error('Missing fountain package');
const savedFiles = [fountain.path, join(dirname(fountain.path), 'CHANGELOG.md')].map((path) => ({
  path,
  content: existsSync(path) ? readFileSync(path) : undefined,
}));

try {
  const result = Bun.spawnSync(
    ['bun', new URL('../node_modules/@changesets/cli/bin.js', import.meta.url).pathname, 'version'],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) throw new Error('Core versioning failed');
} finally {
  // Changesets 2.29.x can patch ignored packages when exiting pre mode.
  // Its ignore setting preserves their changesets, but not always their release files.
  for (const { path, content } of savedFiles) {
    if (content === undefined) rmSync(path, { force: true });
    else if (!existsSync(path) || !readFileSync(path).equals(content)) writeFileSync(path, content);
  }
}
