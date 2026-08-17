import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensureSecretFile, writeSecretFile } from '../../src/utils/files.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('private files', () => {
  test('creates database files and their state directory with private modes', async () => {
    const path = await temporaryPath('coco.db');

    await ensureSecretFile(path);

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('atomically writes secret files with private modes', async () => {
    const path = await temporaryPath('config.json');

    await writeSecretFile(path, 'secret');

    expect(await Bun.file(path).text()).toBe('secret');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-files-'));
  directories.push(directory);
  return join(directory, 'state', name);
}
