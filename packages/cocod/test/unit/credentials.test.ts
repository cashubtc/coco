import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('AdministrativeCredential', () => {
  test('bootstraps distinct private verifier and client credential files', async () => {
    const paths = await temporaryCredentialPaths();

    await AdministrativeCredential.loadOrBootstrap(paths);

    const credential = await loadClientCredential(paths.clientCredentialFile);
    const verifierState = await readFile(paths.verifierFile, 'utf8');
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifierState).not.toContain(credential);
    expect((await stat(dirname(paths.verifierFile))).mode & 0o777).toBe(0o700);
    expect((await stat(paths.verifierFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.clientCredentialFile)).mode & 0o777).toBe(0o600);
  });

  test('reloads existing verifier state without rotating the client credential', async () => {
    const paths = await temporaryCredentialPaths();
    await AdministrativeCredential.loadOrBootstrap(paths);
    const originalCredential = await loadClientCredential(paths.clientCredentialFile);
    const originalVerifierState = await readFile(paths.verifierFile, 'utf8');

    await AdministrativeCredential.loadOrBootstrap(paths);

    expect(await loadClientCredential(paths.clientCredentialFile)).toBe(originalCredential);
    expect(await readFile(paths.verifierFile, 'utf8')).toBe(originalVerifierState);
  });

  test('rejects malformed daemon verifier state instead of bootstrapping', async () => {
    const paths = await temporaryCredentialPaths();
    await AdministrativeCredential.loadOrBootstrap(paths);
    await Bun.write(paths.verifierFile, '{"version":1,"verifier":"plaintext"}');

    await expect(AdministrativeCredential.loadOrBootstrap(paths)).rejects.toThrow(
      'Malformed Cocod credential verifier state',
    );
  });

  test('does not bootstrap over an existing local client credential', async () => {
    const paths = await temporaryCredentialPaths();
    await mkdir(dirname(paths.clientCredentialFile), { recursive: true });
    await writeFile(paths.clientCredentialFile, `${'a'.repeat(43)}\n`, { mode: 0o600 });

    await expect(AdministrativeCredential.loadOrBootstrap(paths)).rejects.toThrow(
      'Malformed Cocod credential activation state',
    );
  });

  test('keeps valid daemon state when the local client credential is missing', async () => {
    const paths = await temporaryCredentialPaths();
    await AdministrativeCredential.loadOrBootstrap(paths);
    await rm(paths.clientCredentialFile);

    await expect(AdministrativeCredential.loadOrBootstrap(paths)).resolves.toBeDefined();
    await expect(loadClientCredential(paths.clientCredentialFile)).rejects.toThrow(
      'Cocod Client Credential file is missing',
    );
  });

  test('authorizes a valid bearer credential for its administrative capabilities', async () => {
    const paths = await temporaryCredentialPaths();
    const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
    const plaintext = await loadClientCredential(paths.clientCredentialFile);

    expect(await credentials.authorize(`Bearer ${plaintext}`, 'wallet:read')).toBe('authorized');
    expect(await credentials.authorize(`Bearer ${plaintext}`, 'wallet:admin')).toBe('authorized');
  });

  test('returns generic authentication and capability decisions', async () => {
    const paths = await temporaryCredentialPaths();
    const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
    const plaintext = await loadClientCredential(paths.clientCredentialFile);

    expect(await credentials.authorize(undefined, 'wallet:read')).toBe('unauthenticated');
    expect(await credentials.authorize(`Bearer ${'z'.repeat(43)}`, 'wallet:read')).toBe(
      'unauthenticated',
    );

    const state = JSON.parse(await readFile(paths.verifierFile, 'utf8')) as {
      capabilities: string[];
    };
    state.capabilities = ['wallet:read'];
    await writeFile(paths.verifierFile, JSON.stringify(state), { mode: 0o600 });
    expect(await credentials.authorize(`Bearer ${plaintext}`, 'wallet:admin')).toBe('forbidden');
  });

  test('corrects private modes when loading existing credential files', async () => {
    const paths = await temporaryCredentialPaths();
    await AdministrativeCredential.loadOrBootstrap(paths);
    await chmod(dirname(paths.verifierFile), 0o755);
    await chmod(paths.verifierFile, 0o644);
    await chmod(paths.clientCredentialFile, 0o644);

    await AdministrativeCredential.loadOrBootstrap(paths);
    await loadClientCredential(paths.clientCredentialFile);

    expect((await stat(dirname(paths.verifierFile))).mode & 0o777).toBe(0o700);
    expect((await stat(paths.verifierFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.clientCredentialFile)).mode & 0o777).toBe(0o600);
  });

  test('rotates both files and immediately invalidates copied credentials', async () => {
    const paths = await temporaryCredentialPaths();
    const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
    const previousCredential = await loadClientCredential(paths.clientCredentialFile);

    await credentials.rotate();

    const rotatedCredential = await loadClientCredential(paths.clientCredentialFile);
    expect(rotatedCredential).not.toBe(previousCredential);
    expect(await credentials.authorize(`Bearer ${previousCredential}`, 'wallet:admin')).toBe(
      'unauthenticated',
    );
    expect(await credentials.authorize(`Bearer ${rotatedCredential}`, 'wallet:admin')).toBe(
      'authorized',
    );
    expect((await stat(paths.verifierFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.clientCredentialFile)).mode & 0o777).toBe(0o600);
  });

  test('keeps the active credential pair usable across concurrent rotations', async () => {
    const paths = await temporaryCredentialPaths();
    const credentials = await AdministrativeCredential.loadOrBootstrap(paths);

    await Promise.all(Array.from({ length: 8 }, () => credentials.rotate()));

    const activeCredential = await loadClientCredential(paths.clientCredentialFile);
    expect(await credentials.authorize(`Bearer ${activeCredential}`, 'wallet:admin')).toBe(
      'authorized',
    );
  });
});

async function temporaryCredentialPaths(): Promise<{
  credentialDirectory: string;
  verifierFile: string;
  clientCredentialFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-credential-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const currentDirectory = join(credentialDirectory, 'current');
  return {
    credentialDirectory,
    verifierFile: join(currentDirectory, 'verifier.json'),
    clientCredentialFile: join(currentDirectory, 'client'),
  };
}
