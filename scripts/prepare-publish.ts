import { writeFileSync } from 'node:fs';
import './check-release';
import { selectRelease } from './release-packages';

// CI-only mutation after validation: Changesets publish does not honor config.ignore.
// Hide other release scopes from its public-package discovery in this checkout.
const release = selectRelease(process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME!);
const selected = new Set(release.selected.map(({ json }) => json.name));
for (const { path, json } of release.packages) {
  if (!json.private && !selected.has(json.name)) {
    writeFileSync(path, `${JSON.stringify({ ...json, private: true }, null, 2)}\n`);
  }
}
console.log(`Prepared publication of ${[...selected].join(', ')}`);
