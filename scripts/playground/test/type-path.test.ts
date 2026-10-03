import { expect, test } from 'bun:test';
import { virtualTypePath } from '../type-path';

test('Windows core files map to the same virtual modules as POSIX builds', () => {
  for (const filename of [
    'C:\\repo\\packages\\core\\models\\Amount.ts',
    'C:/repo/packages/core/models/Amount.ts',
  ]) {
    expect(virtualTypePath('C:\\repo', filename)).toBe(
      'node_modules/@cashu/coco-core/models/Amount.ts',
    );
  }
  expect(virtualTypePath('/repo', '/repo/packages/core/models/Amount.ts')).toBe(
    'node_modules/@cashu/coco-core/models/Amount.ts',
  );
});

test('dependency types use portable module paths, including nested Bun installs', () => {
  for (const filename of [
    'C:\\repo\\node_modules\\@types\\chai\\index.d.ts',
    'C:/repo/node_modules/@types/chai/index.d.ts',
    'C:\\repo\\node_modules\\.bun\\@types+chai@5.2.3\\node_modules\\@types\\chai\\index.d.ts',
    '/repo/node_modules/.bun/@types+chai@5.2.3/node_modules/@types/chai/index.d.ts',
  ]) {
    expect(virtualTypePath('C:\\repo', filename)).toBe('node_modules/@types/chai/index.d.ts');
  }
});

test('other workspace files keep portable relative paths without matching core siblings', () => {
  expect(virtualTypePath('C:\\repo', 'C:\\repo\\packages\\core-extra\\index.ts')).toBe(
    'workspace/packages/core-extra/index.ts',
  );
  expect(virtualTypePath('C:\\repo', 'C:/repo/scripts/shared.d.ts')).toBe(
    'workspace/scripts/shared.d.ts',
  );
  expect(virtualTypePath('/repo', '/repo/scripts/shared.d.ts')).toBe(
    'workspace/scripts/shared.d.ts',
  );
});

test('UNC workspace paths map core files and workspace fallbacks consistently', () => {
  const root = '\\\\server\\share\\repo';
  expect(virtualTypePath(root, '//server/share/repo/packages/core/index.ts')).toBe(
    'node_modules/@cashu/coco-core/index.ts',
  );
  expect(virtualTypePath(root, '\\\\server\\share\\repo\\scripts\\shared.d.ts')).toBe(
    'workspace/scripts/shared.d.ts',
  );
});
