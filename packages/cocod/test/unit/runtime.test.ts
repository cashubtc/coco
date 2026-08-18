import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Manager } from '@cashu/coco-core';

import { CocodRuntime, CocodRuntimeError, type RunningCocoSession } from '../../src/runtime.js';
import { CocoSessionStartupError } from '../../src/utils/wallet.js';
import type { WalletConfig } from '../../src/utils/config.js';
import { deferred } from '../helpers/deferred.js';

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
      mintUrl: 'https://MINT.example.com/',
    });
    await startCalled.promise;

    const result = await initializing;

    expect(runtime.getStatus().seedAccess).toEqual({
      state: 'available',
      requiresPassphrase: false,
    });
    expect(runtime.getStatus().cocoSession.state).toBe('starting');
    expect(result).toEqual({ mnemonic: MNEMONIC, requiresPassphrase: false });

    const start = runtime.startSession();
    sessionReady.resolve(fakeSession());
    await start.completion;

    expect(runtime.getStatus().cocoSession.state).toBe('running');
    expect(runtime.getRunningSession()).not.toBeNull();
    expect(runtime.getStatus().wallet?.mintUrl).toBe('https://mint.example.com');
    expect(JSON.parse(await Bun.file(paths.configFile).text())).toMatchObject({
      mintUrl: 'https://mint.example.com',
    });
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
    expect(runtime.getStatus().seedAccess?.state).toBe('locked');
    await Promise.all([startAccepted.promise, firstStart.accepted, secondStart.accepted]);
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

  test('validates every protected start request while starting and running', async () => {
    const paths = await createPaths();
    const sessionReady = deferred<RunningCocoSession>();
    const initializeSession = mock(async () => sessionReady.promise);
    const runtime = await CocodRuntime.load({ ...paths, initializeSession });
    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });

    const firstStart = runtime.startSession({ passphrase: 'correct horse' });
    expect(() => runtime.startSession()).toThrow('Passphrase required');
    await expect(
      runtime.startSession({ passphrase: 'wrong horse' }).completion,
    ).rejects.toMatchObject({ code: 'wallet_unlock_failed' });

    sessionReady.resolve(fakeSession());
    await firstStart.completion;
    expect(initializeSession).toHaveBeenCalledTimes(1);

    expect(() => runtime.startSession()).toThrow('Passphrase required');
    await expect(
      runtime.startSession({ passphrase: 'wrong horse' }).accepted,
    ).rejects.toMatchObject({ code: 'wallet_unlock_failed' });
    await expect(runtime.startSession({ passphrase: 'correct horse' }).completion).resolves.toBe(
      undefined,
    );
    expect(initializeSession).toHaveBeenCalledTimes(1);
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

  test('quarantines a Session when stop cleanup exceeds its deadline', async () => {
    const paths = await createPaths();
    await Bun.write(paths.configFile, JSON.stringify(walletConfig()));
    const runtime = await CocodRuntime.load({
      ...paths,
      stopTimeoutMs: 5,
      initializeSession: async () => ({
        ...fakeSession(),
        manager: {
          dispose: mock(() => new Promise<void>(() => {})),
        } as unknown as Manager,
      }),
    });
    await runtime.startSession().completion;

    await expect(runtime.stopSession()).rejects.toMatchObject({
      code: 'session_restart_required',
    });

    expect(runtime.getStatus().cocoSession).toMatchObject({
      state: 'failed',
      lastFailure: {
        code: 'session_stop_failed',
        message: 'Coco Session failed to stop cleanly',
      },
    });
  });

  test('restores protected Seed Access policy when stop cleanup fails', async () => {
    const paths = await createPaths();
    const runtime = await CocodRuntime.load({
      ...paths,
      initializeSession: async () => ({
        ...fakeSession(),
        manager: {
          dispose: mock(async () => {
            throw new Error('dispose failed');
          }),
        } as unknown as Manager,
      }),
    });
    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });
    await runtime.startSession({ passphrase: 'correct horse' }).completion;

    await expect(runtime.stopSession()).rejects.toThrow('dispose failed');

    expect(runtime.getStatus()).toMatchObject({
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'failed' },
    });
  });

  test('preserves timeout quarantine when an in-progress start later fails', async () => {
    const paths = await createPaths();
    await Bun.write(paths.configFile, JSON.stringify(walletConfig()));
    const startup = deferred<RunningCocoSession>();
    const runtime = await CocodRuntime.load({
      ...paths,
      stopTimeoutMs: 5,
      initializeSession: async () => startup.promise,
    });

    const start = runtime.startSession();
    const stop = runtime.stopSession();
    await expect(stop).rejects.toMatchObject({ code: 'session_restart_required' });
    startup.reject(new Error('late startup failure'));
    await expect(start.completion).rejects.toThrow('late startup failure');

    expect(runtime.getStatus().cocoSession).toMatchObject({
      state: 'failed',
      lastFailure: { code: 'session_stop_failed' },
    });
    expect(() => runtime.startSession()).toThrow('Cocod process restart required');
  });

  test('preserves timeout quarantine when encrypted Seed Access is acquired late', async () => {
    const paths = await createPaths();
    const initializeSession = mock(async () => fakeSession());
    const runtime = await CocodRuntime.load({
      ...paths,
      stopTimeoutMs: 1,
      initializeSession,
    });
    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });

    const start = runtime.startSession({ passphrase: 'correct horse' });
    await expect(runtime.stopSession()).rejects.toMatchObject({
      code: 'session_restart_required',
    });
    await start.completion.catch(() => {});

    expect(runtime.getStatus().cocoSession).toMatchObject({
      state: 'failed',
      lastFailure: { code: 'session_stop_failed' },
    });
    expect(runtime.getStatus().seedAccess).toEqual({
      state: 'locked',
      requiresPassphrase: true,
    });
    expect(runtime.getRunningSession()).toBeNull();
    expect(() => runtime.startSession({ passphrase: 'correct horse' })).toThrow(
      'Cocod process restart required',
    );
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
        throw new CocoSessionStartupError(
          'startup cleanup failed',
          'unconfirmed',
          new Error('dispose failed'),
        );
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

  test('relocks an encrypted Wallet when failed startup cleanup is unconfirmed', async () => {
    const paths = await createPaths();
    const runtime = await CocodRuntime.load({
      ...paths,
      initializeSession: async () => {
        throw new CocoSessionStartupError(
          'startup cleanup failed',
          'unconfirmed',
          new Error('dispose failed'),
        );
      },
    });
    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });

    await expect(runtime.startSession({ passphrase: 'correct horse' }).completion).rejects.toThrow(
      'startup cleanup failed',
    );

    expect(runtime.getStatus().cocoSession.state).toBe('failed');
    expect(runtime.getStatus().seedAccess).toEqual({
      state: 'locked',
      requiresPassphrase: true,
    });
  });

  test('returns a generated mnemonic before unattended Session startup can fail', async () => {
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

    const initializing = runtime.initializeWallet({});
    await startCalled.promise;

    const result = await initializing;
    const start = runtime.startSession();
    expect(result.mnemonic.split(' ')).toHaveLength(24);
    expect(runtime.getStatus().wallet).not.toBeNull();

    sessionReady.reject(new Error('repository unavailable'));
    await expect(start.completion).rejects.toThrow('repository unavailable');
    expect(runtime.getStatus().cocoSession.state).toBe('stopped');
  });

  test('propagates an unconfirmed startup cleanup failure through a concurrent stop', async () => {
    const paths = await createPaths();
    await Bun.write(paths.configFile, JSON.stringify(walletConfig()));
    const startup = deferred<RunningCocoSession>();
    const runtime = await CocodRuntime.load({
      ...paths,
      initializeSession: async () => startup.promise,
    });

    const start = runtime.startSession();
    const stop = runtime.stopSession();
    const outcomes = Promise.allSettled([start.completion, stop]);
    startup.reject(
      new CocoSessionStartupError(
        'startup cleanup failed',
        'unconfirmed',
        new Error('dispose failed'),
      ),
    );

    const [startOutcome, stopOutcome] = await outcomes;
    expect(startOutcome).toMatchObject({
      status: 'rejected',
      reason: { message: 'startup cleanup failed' },
    });
    expect(stopOutcome).toMatchObject({
      status: 'rejected',
      reason: { message: 'startup cleanup failed' },
    });
    expect(runtime.getStatus().cocoSession.state).toBe('failed');
  });

  test('rejects malformed persisted Wallet configuration before becoming available', async () => {
    const invalidConfigs = [
      walletConfig({ mnemonic: 'not a mnemonic' }),
      walletConfig({ mintUrl: 'not a URL' }),
      walletConfig({ createdAt: 'yesterday' }),
      walletConfig({ encrypted: true, mnemonic: 'not ciphertext' }),
    ];

    for (const config of invalidConfigs) {
      const paths = await createPaths();
      await Bun.write(paths.configFile, JSON.stringify(config));
      await expect(CocodRuntime.load(paths)).rejects.toMatchObject({
        code: 'invalid_wallet_config',
      });
    }

    const paths = await createPaths();
    await Bun.write(paths.configFile, '{not json');
    await expect(CocodRuntime.load(paths)).rejects.toMatchObject({
      code: 'invalid_wallet_config',
    });
  });

  test('rejects a malformed encryption salt', async () => {
    const paths = await createPaths();
    const runtime = await CocodRuntime.load(paths);
    await runtime.initializeWallet({ mnemonic: MNEMONIC, passphrase: 'correct horse' });
    await Bun.write(paths.saltFile, 'not a salt');

    await expect(CocodRuntime.load(paths)).rejects.toMatchObject({
      code: 'invalid_wallet_config',
    });
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
