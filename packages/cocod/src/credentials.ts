import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { CLIENT_CREDENTIAL_FILE, CREDENTIAL_DIRECTORY } from './utils/config.js';
import { writeSecretFile } from './utils/files.js';

export type ClientCapability = 'wallet:read' | 'wallet:admin';
export type AuthorizationResult = 'authorized' | 'unauthenticated' | 'forbidden';

/** Identifies local Client Credential configuration errors that should be shown to CLI users. */
export class ClientCredentialFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClientCredentialFileError';
  }
}

/** Overrides the host-local credential paths, primarily for isolated process instances and tests. */
export interface AdministrativeCredentialPaths {
  credentialDirectory?: string;
}

interface CredentialVerifierState {
  version: 1;
  algorithm: 'sha256';
  verifier: string;
  capabilities: ClientCapability[];
}

const ADMIN_CAPABILITIES = ['wallet:read', 'wallet:admin'] as const;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATIONS_DIRECTORY_NAME = 'generations';
const CURRENT_LINK_NAME = 'current';
const CLIENT_FILE_NAME = 'client';
const VERIFIER_FILE_NAME = 'verifier.json';

/** Owns bootstrap, verification, policy, and host-local rotation for the shared credential. */
export class AdministrativeCredential {
  private constructor(
    private readonly credentialDirectory: string,
    private readonly verifierFile: string,
    private readonly clientCredentialFile: string,
  ) {}

  static async loadOrBootstrap(
    paths: AdministrativeCredentialPaths = {},
  ): Promise<AdministrativeCredential> {
    const credentialDirectory = paths.credentialDirectory ?? CREDENTIAL_DIRECTORY;
    const currentDirectory = join(credentialDirectory, CURRENT_LINK_NAME);
    const credential = new AdministrativeCredential(
      credentialDirectory,
      join(currentDirectory, VERIFIER_FILE_NAME),
      join(currentDirectory, CLIENT_FILE_NAME),
    );

    await ensureCredentialDirectories(credentialDirectory);
    if (!(await pathExists(currentDirectory))) {
      await credential.activateNewGeneration();
    } else {
      await validateCurrentGeneration(credentialDirectory);
      await readVerifierState(credential.verifierFile);
    }

    return credential;
  }

  async authorize(
    authorizationHeader: string | null | undefined,
    requiredCapability: ClientCapability,
  ): Promise<AuthorizationResult> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorizationHeader ?? '');
    if (!match?.[1]) {
      return 'unauthenticated';
    }

    const state = await readVerifierState(this.verifierFile);
    const presentedVerifier = Buffer.from(createVerifier(match[1]), 'utf8');
    const storedVerifier = Buffer.from(state.verifier, 'utf8');
    if (
      presentedVerifier.byteLength !== storedVerifier.byteLength ||
      !timingSafeEqual(presentedVerifier, storedVerifier)
    ) {
      return 'unauthenticated';
    }

    return state.capabilities.includes(requiredCapability) ? 'authorized' : 'forbidden';
  }

  async rotate(): Promise<void> {
    await validateCurrentGeneration(this.credentialDirectory);
    await readVerifierState(this.verifierFile);
    await this.activateNewGeneration();
  }

  private async activateNewGeneration(): Promise<void> {
    const generation = crypto.randomUUID();
    const generationsDirectory = join(this.credentialDirectory, GENERATIONS_DIRECTORY_NAME);
    const generationDirectory = join(generationsDirectory, generation);
    const temporaryLink = join(this.credentialDirectory, `.current.${generation}.tmp`);
    const plaintext = randomBytes(32).toString('base64url');
    const state: CredentialVerifierState = {
      version: 1,
      algorithm: 'sha256',
      verifier: createVerifier(plaintext),
      capabilities: [...ADMIN_CAPABILITIES],
    };
    let activated = false;

    try {
      await mkdir(generationDirectory, { mode: 0o700 });
      await writeSecretFile(join(generationDirectory, CLIENT_FILE_NAME), `${plaintext}\n`);
      await writeSecretFile(
        join(generationDirectory, VERIFIER_FILE_NAME),
        `${JSON.stringify(state, null, 2)}\n`,
      );
      await syncDirectory(generationDirectory);
      await symlink(join(GENERATIONS_DIRECTORY_NAME, generation), temporaryLink, 'dir');
      await rename(temporaryLink, join(this.credentialDirectory, CURRENT_LINK_NAME));
      activated = true;
      await syncDirectory(this.credentialDirectory);
    } catch (error) {
      if (activated) {
        throw new Error(
          'Activated the Cocod administrative credential but failed to sync its state directory',
          { cause: error },
        );
      }
      const cleanupErrors = await cleanupInactiveGeneration(temporaryLink, generationDirectory);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Failed to activate and clean up a Cocod administrative credential generation',
        );
      }
      throw new Error('Failed to activate the Cocod administrative credential generation', {
        cause: error,
      });
    }
  }
}

/** Reads and validates the local plaintext Client Credential without exposing verifier state. */
export async function loadClientCredential(path = CLIENT_CREDENTIAL_FILE): Promise<string> {
  let credential: string;
  try {
    await secureExistingSecretFile(path);
    credential = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClientCredentialFileError(`Cocod Client Credential file is missing: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!CREDENTIAL_PATTERN.test(credential)) {
    throw new ClientCredentialFileError(`Invalid Cocod Client Credential file: ${path}`);
  }
  return credential;
}

function createVerifier(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('base64url');
}

async function readVerifierState(path: string): Promise<CredentialVerifierState> {
  try {
    await secureExistingSecretFile(path);
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isCredentialVerifierState(value)) {
      throw new Error('Unexpected credential verifier schema');
    }
    return value;
  } catch (error) {
    throw new Error(`Malformed Cocod credential verifier state: ${path}`, { cause: error });
  }
}

function isCredentialVerifierState(value: unknown): value is CredentialVerifierState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const state = value as Record<string, unknown>;
  const capabilities = state.capabilities;
  return (
    state.version === 1 &&
    state.algorithm === 'sha256' &&
    typeof state.verifier === 'string' &&
    CREDENTIAL_PATTERN.test(state.verifier) &&
    Array.isArray(capabilities) &&
    capabilities.length > 0 &&
    new Set(capabilities).size === capabilities.length &&
    capabilities.every(
      (capability) => capability === 'wallet:read' || capability === 'wallet:admin',
    )
  );
}

async function ensureCredentialDirectories(credentialDirectory: string): Promise<void> {
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await chmod(credentialDirectory, 0o700);
  const generationsDirectory = join(credentialDirectory, GENERATIONS_DIRECTORY_NAME);
  await mkdir(generationsDirectory, { recursive: true, mode: 0o700 });
  await chmod(generationsDirectory, 0o700);
}

async function validateCurrentGeneration(credentialDirectory: string): Promise<void> {
  const currentLink = join(credentialDirectory, CURRENT_LINK_NAME);
  try {
    const link = await lstat(currentLink);
    if (!link.isSymbolicLink()) {
      throw new Error('Current credential generation is not a symbolic link');
    }

    const target = await readlink(currentLink);
    const generation = target.split('/').at(-1);
    const expectedParent = resolve(credentialDirectory, GENERATIONS_DIRECTORY_NAME);
    const resolvedTarget = resolve(credentialDirectory, target);
    if (
      !generation ||
      !GENERATION_PATTERN.test(generation) ||
      dirname(resolvedTarget) !== expectedParent
    ) {
      throw new Error('Current credential generation target is invalid');
    }

    const generationState = await stat(resolvedTarget);
    if (!generationState.isDirectory()) {
      throw new Error('Current credential generation target is not a directory');
    }
    await chmod(resolvedTarget, 0o700);
  } catch (error) {
    throw new Error(`Malformed Cocod credential activation state: ${currentLink}`, {
      cause: error,
    });
  }
}

async function secureExistingSecretFile(path: string): Promise<void> {
  const fileState = await stat(path);
  if (!fileState.isFile()) {
    throw new Error(`Cocod secret path is not a file: ${path}`);
  }
  await chmod(dirname(path), 0o700);
  await chmod(path, 0o600);
}

async function cleanupInactiveGeneration(
  temporaryLink: string,
  generationDirectory: string,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const cleanup of [
    () => unlink(temporaryLink),
    () => rm(generationDirectory, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(error);
      }
    }
  }
  return errors;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
