import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/** Keep core source records and normalize paths from the test runner's working directory. */
export function scopeCoreCoverage(report: string, sourceRoot: string): string {
  const records: string[] = [];
  for (const record of report.split('end_of_record')) {
    if (!record.trim()) continue;
    const source = /^SF:(.+)$/m.exec(record)?.[1]?.trim();
    if (!source) throw new Error('Coverage record has no source path');
    const path = relative(repositoryRoot, resolve(sourceRoot, source)).replaceAll('\\', '/');
    if (!path.startsWith('packages/core/') || path.startsWith('packages/core/dist/')) continue;
    records.push(record.trim().replace(/^SF:.+$/m, `SF:${path}`) + '\nend_of_record\n');
  }
  if (records.length === 0) throw new Error('Coverage report contains no core source records');
  return records.join('');
}

if (import.meta.main) {
  const [reportPath, sourceRoot] = process.argv.slice(2);
  if (!reportPath || !sourceRoot) {
    throw new Error(
      'Usage: bun scripts/scope-core-coverage.ts <lcov-file> <test-working-directory>',
    );
  }
  const report = Bun.file(reportPath);
  await Bun.write(report, scopeCoreCoverage(await report.text(), sourceRoot));
}
