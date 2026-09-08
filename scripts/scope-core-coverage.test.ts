import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { scopeCoreCoverage } from './scope-core-coverage.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const coreRoot = fileURLToPath(new URL('../packages/core/', import.meta.url));

function record(path: string): string {
  return `TN:\nSF:${path}\nFNF:1\nFNH:0\nDA:1,3\nDA:2,0\nLF:2\nLH:1\nend_of_record\n`;
}

test('keeps core hits and misses while removing imported adapters and generated output', () => {
  const core = record('packages/core/transactions/CoreTransaction.ts');
  const report = [
    core,
    record('packages/sql-storage/src/repositories.ts'),
    record('packages/sqlite-bun/src/db.ts'),
    record('packages/adapter-tests/dist/index.js'),
    record('packages/core/dist/index.js'),
    record('packages/core-other/index.ts'),
  ].join('');
  expect(scopeCoreCoverage(report, repositoryRoot)).toBe(core);
});

test('normalizes package-relative integration paths and absolute source paths', () => {
  const expected = record('packages/core/services/ProofService.ts');
  expect(
    scopeCoreCoverage(
      record('services/ProofService.ts') + record('../sql-storage/src/repositories.ts'),
      coreRoot,
    ),
  ).toBe(expected);
  expect(scopeCoreCoverage(record(`${coreRoot}services/ProofService.ts`), coreRoot)).toBe(expected);
});

test('rejects empty or malformed reports instead of uploading misleading coverage', () => {
  expect(() => scopeCoreCoverage('', repositoryRoot)).toThrow('no core source records');
  expect(() => scopeCoreCoverage(record('packages/sqlite-bun/src/db.ts'), repositoryRoot)).toThrow(
    'no core source records',
  );
  expect(() => scopeCoreCoverage('TN:\nDA:1,1\nend_of_record\n', repositoryRoot)).toThrow(
    'no source path',
  );
});
