import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadClientCredential } from '../../src/credentials.js';
import { DEFAULT_CLIENT_URL } from '../../src/utils/config.js';
import { startTcpTestServer } from '../helpers/tcp.js';

const directories: string[] = [];
const children: Bun.Subprocess[] = [];
const daemonPids: number[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
  for (const pid of daemonPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('the implicit local default auto-starts and stops through the shared TCP resource', async () => {
  const home = await temporaryHome();
  const environment = {
    COCOD_LISTEN_HOST: 'not/a/host',
    COCOD_LISTEN_PORT: 'not-a-port',
  };
  const command = spawnCli(home, ['status'], environment);

  expect(await command.exited).toBe(0);
  const output = await new Response(command.stdout as ReadableStream<Uint8Array>).text();
  expect(output).toContain('"wallet": null');
  expect(output).toContain('"state": "stopped"');
  expect((await waitForHealth(DEFAULT_CLIENT_URL)).status).toBe(200);

  const pid = Number(await readFile(join(home, '.cocod', 'cocod.pid'), 'utf8'));
  daemonPids.push(pid);
  const stop = spawnCli(home, ['stop'], environment);
  expect(await stop.exited).toBe(0);
  await waitForStopped(DEFAULT_CLIENT_URL);
  daemonPids.splice(daemonPids.indexOf(pid), 1);
}, 15_000);

test.each([
  ['logs', ['logs', '--path']],
  ['credential rotate', ['credential', 'rotate']],
  ['daemon', ['daemon']],
] as const)(
  '%s fails clearly when an explicit endpoint selects client-only mode',
  async (_, args) => {
    const home = await temporaryHome();
    const command = spawnCli(home, ['--url', 'https://wallet.example.com', ...args]);

    expect(await command.exited).toBe(1);
    expect(await new Response(command.stderr as ReadableStream<Uint8Array>).text()).toContain(
      'is host-local and cannot use the explicit Cocod endpoint https://wallet.example.com',
    );
  },
);

test('COCOD_URL selects client-only mode and never auto-starts a process', async () => {
  const home = await temporaryHome();
  const reservation = startTcpTestServer({
    fetch: () => Response.json({ status: 'ok', interfaceVersion: '1' }),
  });
  const endpoint = `http://127.0.0.1:${reservation.port}`;
  try {
    const command = spawnCli(home, ['status'], { COCOD_URL: endpoint });
    expect(await command.exited).toBe(1);
    expect(await new Response(command.stderr as ReadableStream<Uint8Array>).text()).toContain(
      'Cocod Client Credential file is missing',
    );
    expect(await Bun.file(join(home, '.cocod', 'cocod.pid')).exists()).toBeFalse();
  } finally {
    await reservation.stop(true);
  }
});

test('one explicitly configured TCP listener serves local and remote authenticated work', async () => {
  const home = await temporaryHome();
  const { daemon, endpoint } = await spawnDaemonOnAvailablePort(home, '0.0.0.0');

  const health = await waitForHealth(endpoint);
  expect(await health.json()).toEqual({ status: 'ok', interfaceVersion: '1' });
  expect(health.headers.get('access-control-allow-origin')).toBeNull();

  const forwardedIdentityOnly = await fetch(`${endpoint}/v1/status`, {
    headers: { 'X-Forwarded-User': 'owner' },
  });
  expect(forwardedIdentityOnly.status).toBe(401);

  const credential = await loadClientCredential(
    join(home, '.cocod', 'credentials', 'current', 'client'),
  );
  const headers = { Authorization: `Bearer ${credential}` };
  const v1Status = await fetch(`${endpoint}/v1/status`, { headers });
  expect(v1Status.status).toBe(200);
  expect(await v1Status.json()).toMatchObject({
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped' },
  });

  const remoteStop = spawnCli(home, ['stop'], { COCOD_URL: endpoint });
  expect(await remoteStop.exited).toBe(0);
  expect(await daemon.exited).toBe(0);

  const stateEntries = await readdir(join(home, '.cocod'));
  expect(stateEntries.some((entry) => entry.endsWith('.sock'))).toBeFalse();
});

test('Wallet initialization sends only a passphrase and prints generated recovery material', async () => {
  const home = await temporaryHome();
  const credential = 'd'.repeat(43);
  await writeClientCredential(home, credential);
  const requests: Array<{ path: string; authorization: string | null; body?: unknown }> = [];
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const server = startTcpTestServer({
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : undefined;
      requests.push({
        path,
        authorization: request.headers.get('authorization'),
        body,
      });
      if (path === '/health') {
        return Response.json({ status: 'ok', interfaceVersion: '1' });
      }
      return Response.json(
        {
          generatedMnemonic: mnemonic,
          status: {
            daemon: { version: '0.0.17', interfaceVersion: '1' },
            wallet: { configuredAt: '2026-08-19T00:00:00.000Z' },
            seedAccess: { state: 'locked', requiresPassphrase: true },
            cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
          },
        },
        { status: 201 },
      );
    },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const command = spawnCli(home, [
      '--url',
      endpoint,
      'wallet',
      'initialize',
      '--passphrase',
      'correct horse',
    ]);

    expect(await command.exited).toBe(0);
    const output = await new Response(command.stdout as ReadableStream<Uint8Array>).text();
    expect(output).toContain('IMPORTANT: Store this Wallet Recovery Material securely');
    expect(output).toContain(mnemonic);
    expect(requests).toEqual([
      { path: '/health', authorization: null, body: undefined },
      {
        path: '/v1/admin/wallet/initialize',
        authorization: `Bearer ${credential}`,
        body: { passphrase: 'correct horse' },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

test('Wallet recovery material can be retrieved after initialization response loss', async () => {
  const home = await temporaryHome();
  const credential = 'g'.repeat(43);
  await writeClientCredential(home, credential);
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const requests: Array<{ path: string; authorization: string | null; body?: unknown }> = [];
  const server = startTcpTestServer({
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : undefined;
      requests.push({ path, authorization: request.headers.get('authorization'), body });
      if (path === '/health') {
        return Response.json({ status: 'ok', interfaceVersion: '1' });
      }
      return Response.json({ mnemonic });
    },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const command = spawnCli(home, [
      '--url',
      endpoint,
      'wallet',
      'recovery-material',
      '--passphrase',
      'correct horse',
    ]);

    expect(await command.exited).toBe(0);
    const output = await new Response(command.stdout as ReadableStream<Uint8Array>).text();
    expect(output).toContain('IMPORTANT: Store this Wallet Recovery Material securely');
    expect(output).toContain(mnemonic);
    expect(requests).toEqual([
      { path: '/health', authorization: null, body: undefined },
      {
        path: '/v1/admin/wallet/recovery-material',
        authorization: `Bearer ${credential}`,
        body: { passphrase: 'correct horse' },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

test('Coco Session start fails when the accepted transition does not reach running', async () => {
  const home = await temporaryHome();
  await writeClientCredential(home, 'e'.repeat(43));
  const starting = lifecycleStatus('starting');
  const failed = {
    ...lifecycleStatus('stopped'),
    cocoSession: {
      state: 'stopped' as const,
      startedAt: null,
      lastFailure: {
        code: 'session_start_failed',
        message: 'Coco Session failed to start',
        occurredAt: '2026-08-19T00:00:01.000Z',
      },
    },
  };
  const server = startTcpTestServer({
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        return Response.json({ status: 'ok', interfaceVersion: '1' });
      }
      if (path === '/v1/admin/session/start') {
        return Response.json(starting, { status: 202 });
      }
      return Response.json(failed);
    },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const command = spawnCli(home, ['--url', endpoint, 'session', 'start']);

    expect(await command.exited).toBe(1);
    const error = await new Response(command.stderr as ReadableStream<Uint8Array>).text();
    expect(error).toContain('Coco Session did not reach running');
    expect(error).toContain('session_start_failed');
  } finally {
    await server.stop(true);
  }
});

test('a TCP bind failure exits clearly without replacing the active listener', async () => {
  const home = await temporaryHome();
  const blocker = startTcpTestServer({
    fetch: () => new Response('occupied'),
  });
  const port = blocker.port;
  const pidFile = join(home, '.cocod', 'cocod.pid');
  await mkdir(join(home, '.cocod'));
  await writeFile(pidFile, '4242');
  try {
    const daemon = spawnDaemon(home, port, '127.0.0.1');
    expect(await daemon.exited).toBe(1);
    expect(await new Response(daemon.stderr as ReadableStream<Uint8Array>).text()).toContain(
      `Failed to bind Cocod TCP listener at http://127.0.0.1:${port}`,
    );
    expect(await readFile(pidFile, 'utf8')).toBe('4242');
    expect(await fetch(`http://127.0.0.1:${port}`)).toHaveProperty('status', 200);

    const recovered = await spawnDaemonOnAvailablePort(home, '127.0.0.1');
    const stop = spawnCli(home, ['stop'], { COCOD_URL: recovered.endpoint });
    expect(await stop.exited).toBe(0);
    expect(await recovered.daemon.exited).toBe(0);
  } finally {
    await blocker.stop(true);
  }
});

test('state directory ownership rejects a second daemon on another TCP address', async () => {
  const home = await temporaryHome();
  const first = await spawnDaemonOnAvailablePort(home, '127.0.0.1');
  const firstPid = await readFile(join(home, '.cocod', 'cocod.pid'), 'utf8');
  const secondPort = await availableTcpPort();

  const second = spawnDaemon(home, secondPort, '127.0.0.1');
  expect(await second.exited).toBe(1);
  expect(await new Response(second.stderr as ReadableStream<Uint8Array>).text()).toContain(
    `Another Cocod process owns the state directory ${join(home, '.cocod')}`,
  );
  expect(await readFile(join(home, '.cocod', 'cocod.pid'), 'utf8')).toBe(firstPid);
  expect((await fetch(`${first.endpoint}/health`)).status).toBe(200);

  const stop = spawnCli(home, ['stop'], { COCOD_URL: first.endpoint });
  expect(await stop.exited).toBe(0);
  expect(await first.daemon.exited).toBe(0);
});

test('state directory ownership is released immediately after a process is killed', async () => {
  const home = await temporaryHome();
  const first = await spawnDaemonOnAvailablePort(home, '127.0.0.1');

  first.daemon.kill('SIGKILL');
  await first.daemon.exited;
  await waitForStopped(first.endpoint);

  const second = await spawnDaemonOnAvailablePort(home, '127.0.0.1');
  expect((await fetch(`${second.endpoint}/health`)).status).toBe(200);

  const stop = spawnCli(home, ['stop'], { COCOD_URL: second.endpoint });
  expect(await stop.exited).toBe(0);
  expect(await second.daemon.exited).toBe(0);
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-tcp-daemon-'));
  directories.push(directory);
  return directory;
}

async function writeClientCredential(home: string, credential: string): Promise<void> {
  const directory = join(home, '.cocod', 'credentials', 'current');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'client'), `${credential}\n`, { mode: 0o600 });
}

function lifecycleStatus(state: 'stopped' | 'starting') {
  return {
    daemon: { version: '0.0.17', interfaceVersion: '1' as const },
    wallet: { configuredAt: '2026-08-19T00:00:00.000Z' },
    seedAccess: { state: 'available' as const, requiresPassphrase: false },
    cocoSession: { state, startedAt: null, lastFailure: null },
  };
}

function spawnDaemon(home: string, port: number, hostname: string): Bun.Subprocess {
  const child = Bun.spawn({
    cmd: ['bun', resolve(import.meta.dir, '../../src/index.ts'), 'daemon'],
    cwd: resolve(import.meta.dir, '../../../..'),
    env: {
      ...childEnvironment(home),
      COCOD_LISTEN_HOST: hostname,
      COCOD_LISTEN_PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  return child;
}

async function spawnDaemonOnAvailablePort(
  home: string,
  hostname: string,
): Promise<{ daemon: Bun.Subprocess; endpoint: string }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const reservation = startTcpTestServer({ fetch: () => new Response('reserved') });
    const port = reservation.port;
    const endpoint = `http://127.0.0.1:${port}`;
    await reservation.stop(true);
    const daemon = spawnDaemon(home, port, hostname);
    if (await waitForDaemonStart(home, endpoint, daemon)) {
      return { daemon, endpoint };
    }
    await daemon.exited;
  }
  throw new Error('Failed to start cocod on an available TCP test port');
}

async function availableTcpPort(): Promise<number> {
  const reservation = startTcpTestServer({ fetch: () => new Response('reserved') });
  const port = reservation.port;
  await reservation.stop(true);
  return port;
}

function spawnCli(
  home: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Bun.Subprocess {
  const child = Bun.spawn({
    cmd: ['bun', resolve(import.meta.dir, '../../src/index.ts'), ...args],
    cwd: resolve(import.meta.dir, '../../../..'),
    env: { ...childEnvironment(home), ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  return child;
}

function childEnvironment(home: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    COCOD_PID: join(home, '.cocod', 'cocod.pid'),
    COCOD_LOG_FILE: join(home, '.cocod', 'daemon.log'),
    COCOD_URL: undefined,
    COCOD_LISTEN_HOST: undefined,
    COCOD_LISTEN_PORT: undefined,
  };
}

async function waitForStopped(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${endpoint}/health`);
    } catch {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Cocod continued accepting connections at ${endpoint}`);
}

async function waitForDaemonStart(
  home: string,
  endpoint: string,
  daemon: Bun.Subprocess,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) {
      return false;
    }
    try {
      const pid = await readFile(join(home, '.cocod', 'cocod.pid'), 'utf8');
      const response = await fetch(`${endpoint}/health`);
      if (Number(pid) === daemon.pid && response.ok) {
        return true;
      }
    } catch {
      // The child has not completed its listener and PID setup yet.
    }
    await Bun.sleep(25);
  }
  return false;
}

async function waitForHealth(endpoint: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) {
        return response;
      }
    } catch {
      // The child has not bound yet.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Cocod did not become healthy at ${endpoint}`);
}
