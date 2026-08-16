import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Manager } from '@cashu/coco-core';

import { CocodRuntime, CocodRuntimeError, type RunningCocoSession } from './runtime.js';
import type { WalletConfig } from './utils/config.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('CocodRuntime', () => {
  test('loads without a Wallet as a stopped runtime', async () => {
    const paths = await createPaths();
    const runtime = await CocodRuntime.load(paths);

    expect(runtime.getStatus()).toEqual({
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('initializes without a passphrase and starts a Coco Session', async () => {
    const paths = await createPaths();
    const startCalled = deferred<void>();
    const sessionReady = deferred<RunningCocoSession>();
    const runtime = await CocodRuntime.load({
      ...paths,
      initializeSession: async () => {
        startCalled.resolve();
        return sessionReady.promise;
      },
    });

    const initializing = runtime.initializeWallet({
      mnemonic: MNEMONIC,
      mintUrl: 'https://mint.example.com',
    });
    await startCalled.promise;

    expect(runtime.getStatus().seedAccess).toEqual({
      state: 'available',
      requiresPassphrase: false,
    });
    expect(runtime.getStatus().cocoSession.state).toBe('starting');

    sessionReady.resolve(fakeSession());
    await initializing;

    expect(runtime.getStatus().cocoSession.state).toBe('running');
    expect(runtime.getRunningSession()).not.toBeNull();
  });

  test('keeps passphrase-protected Seed Access locked until session start', async () => {
    const paths = await createPaths();
    const startAccepted = deferred<void>();
    const sessionReady = deferred<RunningCocoSession>();
    const initializeSession = mock(async (config: WalletConfig, passphrase?: string) => {
      expect(config.encrypted).toBe(false);
      expect(config.mnemonic).toBe(MNEMONIC);
      expect(passphrase).toBeUndefined();
      startAccepted.resolve();
      return sessionReady.promise;
    });
    const runtime = await CocodRuntime.load({ ...paths, initializeSession });

    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });
    expect(runtime.getStatus().seedAccess).toEqual({
      state: 'locked',
      requiresPassphrase: true,
    });
    expect(await Bun.file(paths.configFile).text()).not.toContain(MNEMONIC);
    expect((await stat(dirname(paths.configFile))).mode & 0o777).toBe(0o700);
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.saltFile)).mode & 0o777).toBe(0o600);

    const firstStart = runtime.startSession({ passphrase: 'correct horse' });
    const secondStart = runtime.startSession({ passphrase: 'correct horse' });
    expect(secondStart).toBe(firstStart);
    expect(runtime.getStatus().seedAccess?.state).toBe('locked');
    await Promise.all([startAccepted.promise, firstStart.accepted]);
    expect(initializeSession).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus().seedAccess?.state).toBe('available');

    const session = fakeSession();
    sessionReady.resolve(session);
    await firstStart.completion;
    await runtime.stopSession();

    expect(session.manager.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus().seedAccess?.state).toBe('locked');
    expect(runtime.getStatus().cocoSession.state).toBe('stopped');
  });

  test('keeps Seed Access locked when the passphrase is invalid', async () => {
    const paths = await createPaths();
    const initializeSession = mock(async () => fakeSession());
    const runtime = await CocodRuntime.load({ ...paths, initializeSession });
    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });

    await expect(
      runtime.startSession({ passphrase: 'wrong horse' }).completion,
    ).rejects.toMatchObject({ code: 'wallet_unlock_failed' });

    expect(initializeSession).not.toHaveBeenCalled();
    expect(runtime.getStatus().seedAccess?.state).toBe('locked');
    expect(runtime.getStatus().cocoSession.state).toBe('stopped');
  });

  test('loads an unattended Wallet without starting it until requested', async () => {
    const paths = await createPaths();
    await Bun.write(
      paths.configFile,
      JSON.stringify(walletConfig({ encrypted: false, mnemonic: MNEMONIC })),
    );
    const sessionReady = deferred<RunningCocoSession>();
    const initializeSession = mock(async () => sessionReady.promise);
    const runtime = await CocodRuntime.load({ ...paths, initializeSession });

    expect(runtime.getStatus().cocoSession.state).toBe('stopped');
    expect(runtime.getStatus().seedAccess?.state).toBe('available');

    const start = runtime.startSession();
    expect(runtime.getStatus().cocoSession.state).toBe('starting');
    sessionReady.resolve(fakeSession());
    await start.completion;

    expect(runtime.getStatus().cocoSession.state).toBe('running');
    expect(initializeSession).toHaveBeenCalledTimes(1);
  });

  test('waits for an in-progress start before stopping the resulting session', async () => {
    const paths = await createPaths();
    await Bun.write(paths.configFile, JSON.stringify(walletConfig()));
    const sessionReady = deferred<RunningCocoSession>();
    const runtime = await CocodRuntime.load({
      ...paths,
      initializeSession: async () => sessionReady.promise,
    });

    const start = runtime.startSession();
    const stop = runtime.stopSession();
    expect(runtime.getStatus().cocoSession.state).toBe('stopping');
    expect(() => runtime.startSession()).toThrow('Coco Session is stopping');
    const session = fakeSession();
    sessionReady.resolve(session);
    await Promise.all([start.completion, stop]);

    expect(session.manager.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus().cocoSession.state).toBe('stopped');
  });

  test('records a failed start and permits retry after confirmed cleanup', async () => {
    const paths = await createPaths();
    await Bun.write(paths.configFile, JSON.stringify(walletConfig()));
    const initializeSession = mock(async () => {
      throw new Error('repository unavailable');
    });
    const runtime = await CocodRuntime.load({ ...paths, initializeSession });

    await expect(runtime.startSession().completion).rejects.toThrow('repository unavailable');

    expect(runtime.getStatus().cocoSession.state).toBe('stopped');
    expect(runtime.getStatus().cocoSession.lastFailure).toMatchObject({
      code: 'session_start_failed',
      message: 'Coco Session failed to start',
    });

    await expect(runtime.startSession().completion).rejects.toThrow('repository unavailable');
    expect(initializeSession).toHaveBeenCalledTimes(2);
  });

  test('quarantines the runtime when failed startup cleanup is unconfirmed', async () => {
    const paths = await createPaths();
    await Bun.write(paths.configFile, JSON.stringify(walletConfig()));
    const runtime = await CocodRuntime.load({
      ...paths,
      initializeSession: async () => {
        const error = new Error('startup cleanup failed') as Error & {
          cleanupConfirmed: boolean;
        };
        error.cleanupConfirmed = false;
        throw error;
      },
    });

    await expect(runtime.startSession().completion).rejects.toThrow('startup cleanup failed');
    expect(runtime.getStatus().cocoSession.state).toBe('failed');

    try {
      runtime.startSession();
      throw new Error('expected session start to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CocodRuntimeError);
      expect((error as CocodRuntimeError).code).toBe('session_restart_required');
    }
  });
});

async function createPaths(): Promise<{ configFile: string; saltFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-runtime-'));
  directories.push(directory);
  return {
    configFile: join(directory, 'config.json'),
    saltFile: join(directory, 'salt'),
  };
}

function walletConfig(overrides: Partial<WalletConfig> = {}): WalletConfig {
  return {
    version: 1,
    mnemonic: MNEMONIC,
    encrypted: false,
    mintUrl: 'https://mint.example.com',
    createdAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

function fakeSession(): RunningCocoSession {
  return {
    manager: {
      dispose: mock(async () => {}),
    } as unknown as Manager,
    mintUrl: 'https://mint.example.com',
    npcAccount: {} as RunningCocoSession['npcAccount'],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
