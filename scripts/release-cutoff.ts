const root = process.cwd();

export function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

export function checkPublishedCutoff(version: string): void {
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    throw new Error(
      'Stable release validation requires full history and RC tags; fetch them first',
    );
  }
  // Direct stable releases have no ancestor RC in this version series. A promotion
  // must preserve its cutoff even after pre.json and the release branch are gone.
  const rcTags = git(['tag', '--merged', 'HEAD', '--list', `v${version}-rc.*`]);
  if (rcTags) checkPromotionCutoff(version, true);
}

export function checkPromotionCutoff(target: string, versioned = false): void {
  const cutoff = git(['describe', '--tags', '--match', `v${target}-rc.*`, '--abbrev=0', 'HEAD']);
  if (!new RegExp(`^v${target.replaceAll('.', '\\.')}-rc\\.\\d+$`).test(cutoff)) {
    throw new Error(`Invalid RC cutoff tag: ${cutoff}`);
  }
  checkStableCutoff(cutoff, undefined, versioned);
}

export function checkStableCutoff(cutoff: string, candidate?: string, versioned = true): void {
  const cutoffCommit = git(['rev-parse', '--verify', `${cutoff}^{commit}`]);
  const candidateCommit = git(['rev-parse', '--verify', `${candidate || 'HEAD'}^{commit}`]);
  const ancestry = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', cutoffCommit, candidateCommit],
    {
      cwd: root,
    },
  );
  if (ancestry.exitCode !== 0) {
    throw new Error(`Selected RC cutoff ${cutoff} must be an ancestor of the stable candidate`);
  }
  // An omitted candidate includes staged and unstaged local release files.
  const revisions = candidate ? [cutoffCommit, candidateCommit] : [cutoffCommit];
  const changed = git(['diff', '--name-only', ...revisions, '--'])
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0) throw new Error('Stable candidate has no release metadata changes');
  // Before versioning, only exit intent may differ; afterward allow release files.
  const allowed = versioned
    ? /^(?:\.changeset\/[^/]+|packages\/[^/]+\/(?:package\.json|CHANGELOG\.md)|bun\.lock)$/
    : /^\.changeset\/pre\.json$/;
  if (changed.some((path) => !allowed.test(path))) {
    throw new Error(`Stable promotion must preserve ${cutoff}; cut another RC for new changes`);
  }
  console.log(
    `Verified stable candidate changes only release metadata after cutoff ${cutoffCommit}`,
  );
}
