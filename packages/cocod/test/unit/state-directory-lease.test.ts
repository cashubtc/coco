import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  StateDirectoryLease,
  StateDirectoryLeaseUnavailableError,
} from '../../src/state-directory-lease.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('holds exclusive ownership until the lease is released', async () => {
  const stateDirectory = await temporaryStateDirectory();
  const first = await StateDirectoryLease.acquire(stateDirectory);

  await expect(StateDirectoryLease.acquire(stateDirectory)).rejects.toBeInstanceOf(
    StateDirectoryLeaseUnavailableError,
  );

  await first.release();
  const second = await StateDirectoryLease.acquire(stateDirectory);
  await second.release();
});

test('creates private process state and supports idempotent release', async () => {
  const stateDirectory = await temporaryStateDirectory();
  const lease = await StateDirectoryLease.acquire(stateDirectory);

  expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(stateDirectory, 'daemon-lock.sqlite'))).mode & 0o777).toBe(0o600);

  await lease.release();
  await lease.release();
});

async function temporaryStateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocod-state-directory-lease-'));
  directories.push(root);
  return join(root, 'state');
}
