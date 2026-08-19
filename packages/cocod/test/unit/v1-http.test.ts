import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAmount } from '@cashu/coco-core';

import {
  AdministrativeCredential,
  loadClientCredential,
  type ClientCapability,
} from '../../src/credentials.js';
import type { CocodStatus } from '../../src/runtime.js';
import { ProcessShutdownCoordinator } from '../../src/process-shutdown.js';
import { CocodRuntimeError } from '../../src/runtime-error.js';
import {
  buildV1Routes,
  createV1RouteDefinitions,
  defineV1Route,
  type LifecycleStatusDocument,
  type RuntimeSchema,
  type V1Runtime,
} from '../../src/v1/http.js';
import { deferred } from '../helpers/deferred.js';
import { createTestLogger } from '../helpers/logger.js';
import { createLifecycleTestRouteDefinitions } from '../helpers/v1.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('v1 HTTP route interface', () => {
  test('registers a normalized Known Mint without granting trust', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    const addMint = mock(async (mintUrl: string, options?: { trusted?: boolean }) => ({
      mint,
      keysets: [],
      created: true,
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { mint: { addMint, getAllMints: async () => [mint] } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints']!.POST!(
      authorizedJsonRequest('/v1/mints', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe(
      '/v1/mints/by-url?mintUrl=https%3A%2F%2Fmint.example.com',
    );
    expect(await response.json()).toEqual({
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      trusted: false,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(addMint).toHaveBeenCalledWith('https://mint.example.com');

    const canonical = await routes['/v1/mints/by-url']!.GET!(
      authorizedRequest(response.headers.get('location')!, credential.plaintext),
    );
    expect(await canonical.json()).toEqual({
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      trusted: false,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
  });

  test('lists Known Mints and preserves trust on duplicate registration', async () => {
    const credential = await createCredential();
    const knownMint = {
      mintUrl: 'https://mint.example.com/',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: true,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    const getAllMints = mock(async () => [knownMint]);
    const getAllTrustedMints = mock(async () => [knownMint]);
    const addMint = mock(async () => ({ mint: knownMint, keysets: [], created: false }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { mint: { addMint, getAllMints, getAllTrustedMints } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const listed = await routes['/v1/mints']!.GET!(
      authorizedRequest('/v1/mints?trustedOnly=true', credential.plaintext),
    );
    const duplicate = await routes['/v1/mints']!.POST!(
      authorizedJsonRequest('/v1/mints', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
      }),
    );

    expect(await listed.json()).toEqual({
      items: [
        {
          mintUrl: 'https://mint.example.com',
          name: 'Example Mint',
          trusted: true,
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:01:00.000Z',
        },
      ],
    });
    expect(getAllTrustedMints).toHaveBeenCalledTimes(1);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      mintUrl: 'https://mint.example.com',
      trusted: true,
    });
    expect(addMint).toHaveBeenCalledWith('https://mint.example.com');
  });

  test('uses Coco registration results for concurrent creation status', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    let registrations = 0;
    const addMint = mock(async () => ({
      mint,
      keysets: [],
      created: registrations++ === 0,
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({ manager: { mint: { addMint } } }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );
    const register = () =>
      routes['/v1/mints']!.POST!(
        authorizedJsonRequest('/v1/mints', credential.plaintext, {
          mintUrl: mint.mintUrl,
        }),
      );

    const responses = await Promise.all([register(), register()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(addMint).toHaveBeenCalledTimes(2);
  });

  test('changes trust only through explicit authenticated commands', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    const getAllMints = mock(async () => [mint]);
    const trustMint = mock(async () => {
      mint.trusted = true;
    });
    const untrustMint = mock(async () => {
      mint.trusted = false;
    });
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { mint: { getAllMints, trustMint, untrustMint } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/mints/trust']!.POST!(
      new Request('http://localhost/v1/mints/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintUrl: mint.mintUrl }),
      }),
    );
    const trusted = await routes['/v1/mints/trust']!.POST!(
      authorizedJsonRequest('/v1/mints/trust', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
      }),
    );
    const untrusted = await routes['/v1/mints/untrust']!.POST!(
      authorizedJsonRequest('/v1/mints/untrust', credential.plaintext, {
        mintUrl: mint.mintUrl,
      }),
    );

    expect(unauthenticated.status).toBe(401);
    expect(trustMint).toHaveBeenCalledWith('https://mint.example.com');
    expect(await trusted.json()).toMatchObject({ trusted: true });
    expect(untrustMint).toHaveBeenCalledWith('https://mint.example.com');
    expect(await untrusted.json()).toMatchObject({ trusted: false });
  });

  test('returns refreshed Mint information and safely maps refresh failures', async () => {
    const credential = await createCredential();
    const getMintInfo = mock(async () => ({
      name: 'Example Mint',
      description: 'Fresh metadata',
      nuts: { '4': { disabled: false, methods: [] } },
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          mint: {
            getAllMints: async () => [
              {
                mintUrl: 'https://mint.example.com',
                name: 'Example Mint',
                trusted: false,
                createdAt: 1_786_838_400,
                updatedAt: 1_786_838_460,
              },
            ],
            getMintInfo,
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints/info']!.GET!(
      authorizedRequest(
        '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.example.com%2F',
        credential.plaintext,
      ),
    );

    expect(await response.json()).toEqual({
      mintUrl: 'https://mint.example.com',
      info: {
        name: 'Example Mint',
        description: 'Fresh metadata',
        nuts: { '4': { disabled: false, methods: [] } },
      },
    });
    expect(getMintInfo).toHaveBeenCalledWith('https://mint.example.com');

    getMintInfo.mockImplementation(async () => {
      throw new Error('https://mint.example.com/private?token=secret');
    });
    const failed = await routes['/v1/mints/info']!.GET!(
      authorizedRequest(
        '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.example.com',
        credential.plaintext,
      ),
    );
    const failureDocument = await failed.json();
    expect(failed.status).toBe(500);
    expect(failureDocument).toMatchObject({
      error: { code: 'coco_error', retryable: false },
    });
    expect(JSON.stringify(failureDocument)).not.toContain('token=secret');
  });

  test('lists lossless payment-method capabilities for a Known Mint', async () => {
    const credential = await createCredential();
    const listPaymentMethodCapabilities = mock(async () => [
      {
        operation: 'mint' as const,
        nut: 4 as const,
        method: 'bolt11',
        unit: 'sat',
        minAmount: toAmount(9_007_199_254_740_993n),
        maxAmount: null,
        options: { reusable: true },
      },
    ]);
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          mint: {
            getAllMints: async () => [
              {
                mintUrl: 'https://mint.example.com',
                name: 'Example Mint',
                trusted: false,
                createdAt: 1_786_838_400,
                updatedAt: 1_786_838_460,
              },
            ],
            listPaymentMethodCapabilities,
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints/payment-method-capabilities']!.GET!(
      authorizedRequest(
        '/v1/mints/payment-method-capabilities?mintUrl=https%3A%2F%2Fmint.example.com%2F',
        credential.plaintext,
      ),
    );

    expect(await response.json()).toEqual({
      items: [
        {
          operation: 'mint',
          nut: 4,
          method: 'bolt11',
          unit: 'sat',
          minAmount: '9007199254740993',
          maxAmount: null,
          options: { reusable: true },
        },
      ],
    });
    expect(listPaymentMethodCapabilities).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
    });
  });

  test('rejects invalid Mint requests and unknown trust targets before mutation', async () => {
    const credential = await createCredential();
    const addMint = mock(async () => {
      throw new Error('must not register invalid input');
    });
    const trustMint = mock(async () => {
      throw new Error('must not trust unknown input');
    });
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          mint: {
            addMint,
            getAllMints: async () => [],
            getAllTrustedMints: async () => [],
            getMintInfo: async () => ({}),
            listPaymentMethodCapabilities: async () => [],
            trustMint,
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const invalidRequests = [
      routes['/v1/mints']!.POST!(
        authorizedJsonRequest('/v1/mints', credential.plaintext, { mintUrl: 'ftp://mint.test' }),
      ),
      routes['/v1/mints']!.GET!(
        authorizedRequest('/v1/mints?trustedOnly=yes', credential.plaintext),
      ),
      routes['/v1/mints/info']!.GET!(
        authorizedRequest(
          '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.test&extra=1',
          credential.plaintext,
        ),
      ),
      routes['/v1/mints/payment-method-capabilities']!.GET!(
        authorizedRequest(
          '/v1/mints/payment-method-capabilities?mintUrl=https%3A%2F%2Fmint.test&operation=mint',
          credential.plaintext,
        ),
      ),
    ];

    for (const pending of invalidRequests) {
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', retryable: false },
      });
    }

    const unknown = await routes['/v1/mints/trust']!.POST!(
      authorizedJsonRequest('/v1/mints/trust', credential.plaintext, {
        mintUrl: 'https://unknown.example.com',
      }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(addMint).not.toHaveBeenCalled();
    expect(trustMint).not.toHaveBeenCalled();
  });

  test('returns filtered balances as lossless flat v1 resources', async () => {
    const credential = await createCredential();
    const byMintAndUnit = mock(async () => ({
      'https://mint.example.com': {
        sat: {
          spendable: toAmount(9_007_199_254_740_993n),
          reserved: toAmount(7),
          total: toAmount(9_007_199_254_741_000n),
          unit: 'sat',
        },
        usd: {
          spendable: toAmount(2),
          reserved: toAmount(1),
          total: toAmount(3),
          unit: 'usd',
        },
      },
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { wallet: { balances: { byMintAndUnit } } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/balances']!.GET!(
      new Request('http://localhost/v1/balances'),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: 'unauthenticated', retryable: false },
    });
    expect(byMintAndUnit).not.toHaveBeenCalled();

    const response = await routes['/v1/balances']!.GET!(
      authorizedRequest(
        '/v1/balances?mintUrl=https%3A%2F%2Fmint.example.com&mintUrl=https%3A%2F%2Fmint.other&unit=sat&unit=usd&trustedOnly=true',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          mintUrl: 'https://mint.example.com',
          unit: 'sat',
          spendable: '9007199254740993',
          reserved: '7',
          total: '9007199254741000',
        },
        {
          mintUrl: 'https://mint.example.com',
          unit: 'usd',
          spendable: '2',
          reserved: '1',
          total: '3',
        },
      ],
    });
    expect(byMintAndUnit).toHaveBeenCalledWith({
      mintUrls: ['https://mint.example.com', 'https://mint.other'],
      units: ['sat', 'usd'],
      trustedOnly: true,
    });
  });

  test('returns a safe v1 error when Coco cannot read balances', async () => {
    const credential = await createCredential();
    const unsafeDiagnostic = 'postgres://owner:secret@wallet-db';
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          wallet: {
            balances: {
              byMintAndUnit: async () => {
                throw new Error(unsafeDiagnostic);
              },
            },
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/balances']!.GET!(
      authorizedRequest('/v1/balances', credential.plaintext),
    );
    const document = await response.json();

    expect(response.status).toBe(500);
    expect(document).toEqual({
      error: {
        code: 'coco_error',
        message: 'Coco could not return Wallet balances',
        retryable: false,
      },
    });
    expect(JSON.stringify(document)).not.toContain(unsafeDiagnostic);
  });

  test('rejects invalid balance filters before calling Coco', async () => {
    const credential = await createCredential();
    const byMintAndUnit = mock(async () => ({}));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { wallet: { balances: { byMintAndUnit } } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    for (const query of [
      'trustedOnly=yes',
      'trustedOnly=true&trustedOnly=false',
      'mintUrl=not-a-url',
      'mintUrl=ftp%3A%2F%2Fmint.example.com',
      'unit=',
      'unexpected=sat',
    ]) {
      const response = await routes['/v1/balances']!.GET!(
        authorizedRequest(`/v1/balances?${query}`, credential.plaintext),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', retryable: false },
      });
    }
    expect(byMintAndUnit).not.toHaveBeenCalled();
  });

  test('maps every inactive Coco Session state to its shared v1 error', async () => {
    const credential = await createCredential();
    const cases: Array<{
      status: CocodStatus;
      httpStatus: number;
      code: string;
      retryable: boolean;
      retryAfter?: string;
    }> = [
      {
        status: unconfiguredStatus(),
        httpStatus: 409,
        code: 'wallet_not_configured',
        retryable: false,
      },
      {
        status: configuredStatus('starting'),
        httpStatus: 503,
        code: 'session_transition_in_progress',
        retryable: true,
        retryAfter: '1',
      },
      {
        status: configuredStatus('stopping'),
        httpStatus: 503,
        code: 'session_transition_in_progress',
        retryable: true,
        retryAfter: '1',
      },
      {
        status: configuredStatus('failed'),
        httpStatus: 503,
        code: 'session_restart_required',
        retryable: false,
      },
      {
        status: {
          ...configuredStatus('stopped'),
          seedAccess: { state: 'locked', requiresPassphrase: true },
        },
        httpStatus: 423,
        code: 'wallet_locked',
        retryable: false,
      },
      {
        status: configuredStatus('stopped'),
        httpStatus: 503,
        code: 'session_stopped',
        retryable: true,
      },
    ];

    for (const testCase of cases) {
      const runtime = lifecycleRuntime(() => testCase.status);
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
        credential.credentials,
      );

      const response = await routes['/v1/balances']!.GET!(
        authorizedRequest('/v1/balances', credential.plaintext),
      );

      expect(response.status).toBe(testCase.httpStatus);
      expect(response.headers.get('retry-after')).toBe(testCase.retryAfter ?? null);
      expect(await response.json()).toMatchObject({
        error: { code: testCase.code, retryable: testCase.retryable },
      });
    }
  });

  test('declares implemented v1 routes with their runtime schemas and capabilities', () => {
    const routes = createLifecycleTestRouteDefinitions(
      statusRuntime(unconfiguredStatus()),
      '0.0.17',
    );

    expect(
      routes.map(
        ({
          method,
          path,
          capability,
          requestSchema,
          responseSchema,
          successStatuses,
          idempotencyKey,
          responseCacheControl,
        }) => ({
          method,
          path,
          capability,
          requestSchema: requestSchema.name,
          responseSchema: responseSchema.name,
          successStatuses,
          idempotencyKey,
          responseCacheControl,
        }),
      ),
    ).toEqual([
      {
        method: 'GET',
        path: '/health',
        capability: null,
        requestSchema: 'NoBody',
        responseSchema: 'Health',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/status',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'LifecycleStatus',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/balances',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'Balances',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'KnownMints',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints/by-url',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'KnownMint',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/mints',
        capability: 'wallet:admin',
        requestSchema: 'MintUrlRequest',
        responseSchema: 'KnownMint',
        successStatuses: [200, 201],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/mints/trust',
        capability: 'wallet:admin',
        requestSchema: 'MintUrlRequest',
        responseSchema: 'KnownMint',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/mints/untrust',
        capability: 'wallet:admin',
        requestSchema: 'MintUrlRequest',
        responseSchema: 'KnownMint',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints/info',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'MintInformation',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints/payment-method-capabilities',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'PaymentMethodCapabilities',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/admin/wallet/initialize',
        capability: 'wallet:admin',
        requestSchema: 'InitializeWalletRequest',
        responseSchema: 'InitializeWalletResponse',
        successStatuses: [201, 202],
        idempotencyKey: 'optional',
        responseCacheControl: 'no-store',
      },
      {
        method: 'POST',
        path: '/v1/admin/wallet/recovery-material',
        capability: 'wallet:admin',
        requestSchema: 'WalletRecoveryMaterialRequest',
        responseSchema: 'WalletRecoveryMaterialResponse',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: 'no-store',
      },
      {
        method: 'POST',
        path: '/v1/admin/session/start',
        capability: 'wallet:admin',
        requestSchema: 'StartSessionRequest',
        responseSchema: 'LifecycleStatus',
        successStatuses: [200, 202],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/admin/session/stop',
        capability: 'wallet:admin',
        requestSchema: 'StopSessionRequest',
        responseSchema: 'LifecycleStatus',
        successStatuses: [200, 202],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/admin/process/stop',
        capability: 'wallet:admin',
        requestSchema: 'ProcessShutdownRequest',
        responseSchema: 'ProcessShutdownResponse',
        successStatuses: [202],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
    ]);
  });

  test('authenticates and accepts Cocod Process shutdown', async () => {
    const credential = await createCredential();
    const requestShutdown = mock(async (_reason: 'http_stop') => 0);
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17', {
        request: requestShutdown,
      }),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/admin/process/stop']!.POST!(
      new Request('http://localhost/v1/admin/process/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    const accepted = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}),
    );

    expect(unauthenticated.status).toBe(401);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith('http_stop');
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: 'stopping' });
  });

  test('rejects new v1 work after shutdown acceptance while replaying stop acceptance', async () => {
    const credential = await createCredential();
    let acceptingWork = true;
    const requestShutdown = mock(async (_reason: 'http_stop') => {
      acceptingWork = false;
      return 0;
    });
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17', {
        request: requestShutdown,
      }),
      credential.credentials,
      undefined,
      { isAcceptingWork: () => acceptingWork },
    );

    const accepted = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}),
    );
    const rejected = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );
    const concurrent = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}),
    );

    expect(accepted.status).toBe(202);
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'process_shutting_down', retryable: false },
    });
    expect(concurrent.status).toBe(202);
    expect(await concurrent.json()).toEqual({ status: 'stopping' });
  });

  test('continues an accepted shutdown after the initiating client disconnects', async () => {
    const credential = await createCredential();
    const listenerClosed = deferred<void>();
    const exit = mock((_code: number) => {});
    const shutdown = new ProcessShutdownCoordinator({
      closeListener: () => listenerClosed.promise,
      disposeRuntime: async () => {},
      cleanupProcessState: async () => {},
      flushLogs: async () => {},
      reportFailure: () => {},
      exit,
      logger: createTestLogger(),
    });
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17', shutdown),
      credential.credentials,
    );
    const controller = new AbortController();

    const response = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}, controller.signal),
    );
    controller.abort();
    listenerClosed.resolve();

    expect(response.status).toBe(202);
    expect(await shutdown.request('http_stop')).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('returns the documented status resource in every Coco Session state', async () => {
    const credential = await createCredential();
    const states = ['stopped', 'starting', 'running', 'stopping', 'failed'] as const;

    for (const state of states) {
      const status = configuredStatus(state);
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(statusRuntime(status), '0.0.17'),
        credential.credentials,
      );
      const response = await routes['/v1/status']!.GET!(
        authorizedRequest('/v1/status', credential.plaintext),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toStartWith('application/json');
      expect(response.headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await response.json()).toEqual({
        daemon: { version: '0.0.17', interfaceVersion: '1' },
        wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
        seedAccess: { state: 'available', requiresPassphrase: false },
        cocoSession: {
          state,
          startedAt: state === 'running' ? '2026-08-16T00:00:01.000Z' : null,
          lastFailure:
            state === 'failed'
              ? {
                  code: 'session_start_failed',
                  message: 'Coco Session failed to start',
                  occurredAt: '2026-08-16T00:00:02.000Z',
                }
              : null,
        },
      });
    }
  });

  test('returns null Wallet and Seed Access when no Wallet is configured', async () => {
    const credential = await createCredential();
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );

    expect(await response.json()).toEqual({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('returns a configured Wallet with locked Seed Access and no running session', async () => {
    const credential = await createCredential();
    const status: CocodStatus = {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    };
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(statusRuntime(status), '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );

    expect(await response.json()).toEqual({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('initializes only host-generated Wallets with non-cacheable transition responses', async () => {
    const credential = await createCredential();
    const generatedMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    for (const request of [
      { body: { passphrase: 'correct horse' }, status: 201, state: 'stopped' as const },
      { body: {}, status: 202, state: 'starting' as const },
    ]) {
      let status = unconfiguredStatus();
      const initializeWallet = mock(async (input: { passphrase?: string }) => {
        const requiresPassphrase = Boolean(input.passphrase);
        status = {
          wallet: {
            configuredAt: '2026-08-16T00:00:00.000Z',
            mintUrl: 'https://mint.example.com',
          },
          seedAccess: {
            state: requiresPassphrase ? 'locked' : 'available',
            requiresPassphrase,
          },
          cocoSession: { state: request.state, startedAt: null, lastFailure: null },
        };
        return { mnemonic: generatedMnemonic, requiresPassphrase };
      });
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(
          lifecycleRuntime(() => status, { initializeWallet }),
          '0.0.17',
        ),
        credential.credentials,
      );

      const response = await routes['/v1/admin/wallet/initialize']!.POST!(
        authorizedJsonRequest('/v1/admin/wallet/initialize', credential.plaintext, request.body),
      );

      expect(response.status).toBe(request.status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        generatedMnemonic,
        status: {
          daemon: { version: '0.0.17', interfaceVersion: '1' },
          wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
          seedAccess: status.seedAccess,
          cocoSession: status.cocoSession,
        },
      });
      expect(initializeWallet).toHaveBeenCalledWith(request.body);
    }

    const initializeWallet = mock(async () => ({
      mnemonic: generatedMnemonic,
      requiresPassphrase: false,
    }));
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(unconfiguredStatus, { initializeWallet }),
        '0.0.17',
      ),
      credential.credentials,
    );
    const importAttempt = await routes['/v1/admin/wallet/initialize']!.POST!(
      authorizedJsonRequest('/v1/admin/wallet/initialize', credential.plaintext, {
        mnemonic: generatedMnemonic,
      }),
    );
    expect(importAttempt.status).toBe(400);
    expect(initializeWallet).not.toHaveBeenCalled();
  });

  test('retrieves Wallet Recovery Material repeatably with a non-cacheable response', async () => {
    const credential = await createCredential();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const status = configuredStatus('failed');
    const getWalletRecoveryMaterial = mock(async () => mnemonic);
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(() => status, { getWalletRecoveryMaterial }),
        '0.0.17',
      ),
      credential.credentials,
    );

    for (let retrieval = 0; retrieval < 2; retrieval += 1) {
      const response = await routes['/v1/admin/wallet/recovery-material']!.POST!(
        authorizedJsonRequest(
          '/v1/admin/wallet/recovery-material',
          credential.plaintext,
          { passphrase: 'correct horse' },
          undefined,
          { 'Idempotency-Key': 'not-required-for-retrieval' },
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ mnemonic });
      expect(status.cocoSession.state).toBe('failed');
    }
    expect(getWalletRecoveryMaterial).toHaveBeenCalledTimes(2);
    expect(getWalletRecoveryMaterial).toHaveBeenCalledWith({ passphrase: 'correct horse' });
  });

  test('protects recovery retrieval and keeps request and response secrets out of logs', async () => {
    const credential = await createCredential();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const correctPassphrase = 'correct horse battery staple';
    const wrongPassphrase = 'wrong secret passphrase';
    const getWalletRecoveryMaterial = mock(async ({ passphrase }: { passphrase?: string }) => {
      if (!passphrase) {
        throw new CocodRuntimeError('passphrase_required', 'unsafe missing-passphrase detail');
      }
      if (passphrase !== correctPassphrase) {
        throw new CocodRuntimeError('wallet_unlock_failed', `unsafe ${passphrase}`);
      }
      return mnemonic;
    });
    const debug = mock((_event: string, _fields?: unknown) => {});
    const info = mock((_event: string, _fields?: unknown) => {});
    const warn = mock((_event: string, _fields?: unknown) => {});
    const error = mock((_event: string, _fields?: unknown) => {});
    const logger = createTestLogger({ debug, info, warn, error });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(() => configuredStatus('running'), { getWalletRecoveryMaterial }),
        '0.0.17',
      ),
      credential.credentials,
      logger,
    );
    const recoveryRoute = routes['/v1/admin/wallet/recovery-material']!.POST!;

    const unauthenticated = await recoveryRoute(
      new Request('http://localhost/v1/admin/wallet/recovery-material', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: correctPassphrase }),
      }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(getWalletRecoveryMaterial).not.toHaveBeenCalled();

    const missing = await recoveryRoute(
      authorizedJsonRequest('/v1/admin/wallet/recovery-material', credential.plaintext, {}),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: {
        code: 'passphrase_required',
        message: 'A passphrase is required',
        retryable: false,
      },
    });

    const invalid = await recoveryRoute(
      authorizedJsonRequest('/v1/admin/wallet/recovery-material', credential.plaintext, {
        passphrase: wrongPassphrase,
      }),
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({
      error: {
        code: 'wallet_unlock_failed',
        message: 'Wallet unlock failed',
        retryable: false,
      },
    });

    const success = await recoveryRoute(
      authorizedJsonRequest('/v1/admin/wallet/recovery-material', credential.plaintext, {
        passphrase: correctPassphrase,
      }),
    );
    expect(await success.json()).toEqual({ mnemonic });

    const logs = JSON.stringify([
      debug.mock.calls,
      info.mock.calls,
      warn.mock.calls,
      error.mock.calls,
    ]);
    expect(logs).not.toContain(correctPassphrase);
    expect(logs).not.toContain(wrongPassphrase);
    expect(logs).not.toContain(mnemonic);
    expect(logs).not.toContain(credential.plaintext);
  });

  test('returns asynchronous Session transition status without awaiting completion', async () => {
    const credential = await createCredential();
    let status = configuredStatus('stopped');
    const startRequested = deferred<void>();
    const startAccepted = deferred<void>();
    const startCompletion = deferred<void>();
    const stopCompletion = deferred<void>();
    const runtime = lifecycleRuntime(() => status, {
      startSession: () => {
        startRequested.resolve();
        if (status.cocoSession.state === 'stopped') {
          status = { ...status, cocoSession: { ...status.cocoSession, state: 'starting' } };
        }
        return {
          accepted: startAccepted.promise,
          completion: startCompletion.promise.then(() => {
            status = {
              ...status,
              cocoSession: {
                state: 'running',
                startedAt: '2026-08-16T00:00:01.000Z',
                lastFailure: null,
              },
            };
          }),
        };
      },
      stopSession: () => {
        if (status.cocoSession.state === 'running') {
          status = { ...status, cocoSession: { ...status.cocoSession, state: 'stopping' } };
          return stopCompletion.promise.then(() => {
            status = configuredStatus('stopped');
          });
        }
        return Promise.resolve();
      },
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const controller = new AbortController();
    const startingResponse = routes['/v1/admin/session/start']!.POST!(
      authorizedJsonRequest('/v1/admin/session/start', credential.plaintext, {}, controller.signal),
    );
    await startRequested.promise;
    controller.abort();
    startAccepted.resolve();
    const starting = await startingResponse;
    expect(starting.status).toBe(202);
    expect(((await starting.json()) as LifecycleStatusDocument).cocoSession.state).toBe('starting');

    startCompletion.resolve();
    await startCompletion.promise;
    await Promise.resolve();
    expect(status.cocoSession.state).toBe('running');

    const alreadyRunning = await routes['/v1/admin/session/start']!.POST!(
      authorizedJsonRequest('/v1/admin/session/start', credential.plaintext, {}),
    );
    expect(alreadyRunning.status).toBe(200);

    const stopping = await routes['/v1/admin/session/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/session/stop', credential.plaintext, {}),
    );
    expect(stopping.status).toBe(202);
    expect(((await stopping.json()) as LifecycleStatusDocument).cocoSession.state).toBe('stopping');

    stopCompletion.resolve();
    await stopCompletion.promise;
    await Promise.resolve();
    const alreadyStopped = await routes['/v1/admin/session/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/session/stop', credential.plaintext, {}),
    );
    expect(alreadyStopped.status).toBe(200);
  });

  test('returns accepted when stop cancels encrypted startup before Seed Access is acquired', async () => {
    const credential = await createCredential();
    let status: CocodStatus = {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    };
    const stopCompletion = deferred<void>();
    const runtime = lifecycleRuntime(() => status, {
      stopSession: () => {
        status = { ...status, cocoSession: { ...status.cocoSession, state: 'stopping' } };
        return stopCompletion.promise;
      },
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/admin/session/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/session/stop', credential.plaintext, {}),
    );

    expect(response.status).toBe(202);
    expect(((await response.json()) as LifecycleStatusDocument).cocoSession.state).toBe('stopping');
    stopCompletion.resolve();
  });

  test('logs detached transition failures without raw diagnostics', async () => {
    const credential = await createCredential();
    const completion = deferred<void>();
    const failureLogged = deferred<void>();
    const error = mock((event: string, _fields?: unknown) => {
      if (event === 'lifecycle.transition_failed') {
        failureLogged.resolve();
      }
    });
    const logger = createTestLogger({ error });
    let status = configuredStatus('stopped');
    const runtime = lifecycleRuntime(() => status, {
      startSession: () => {
        status = { ...status, cocoSession: { ...status.cocoSession, state: 'starting' } };
        return { accepted: Promise.resolve(), completion: completion.promise };
      },
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17', logger),
      credential.credentials,
      logger,
    );

    const response = await routes['/v1/admin/session/start']!.POST!(
      authorizedJsonRequest('/v1/admin/session/start', credential.plaintext, {}),
    );
    expect(response.status).toBe(202);
    completion.reject(new Error('postgres://owner:password@wallet-db'));
    await failureLogged.promise;

    expect(JSON.stringify(error.mock.calls)).not.toContain('postgres://owner:password@wallet-db');
    expect(error).toHaveBeenCalledWith('lifecycle.transition_failed', {
      transition: 'session_start',
      error: { name: 'Error' },
    });
  });

  test('maps every synchronous runtime lifecycle failure to stable v1 errors', async () => {
    const credential = await createCredential();
    const cases = [
      {
        path: '/v1/admin/wallet/initialize',
        code: 'wallet_already_configured',
        expectedStatus: 409,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'wallet_not_configured',
        expectedStatus: 409,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'passphrase_required',
        expectedStatus: 400,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'wallet_unlock_failed',
        expectedStatus: 401,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'session_transition_in_progress',
        expectedStatus: 409,
        retryable: true,
      },
      {
        path: '/v1/admin/session/start',
        code: 'session_restart_required',
        expectedStatus: 503,
        retryable: false,
      },
      {
        path: '/v1/admin/session/stop',
        code: 'session_restart_required',
        expectedStatus: 503,
        retryable: false,
      },
    ] as const;

    for (const testCase of cases) {
      const failure = new CocodRuntimeError(testCase.code, 'unsafe internal diagnostic');
      const runtime = lifecycleRuntime(() => configuredStatus('stopped'), {
        initializeWallet: async () => {
          throw failure;
        },
        startSession: () => {
          if (testCase.code === 'wallet_unlock_failed') {
            const rejected = Promise.reject(failure);
            return { accepted: rejected, completion: rejected };
          }
          throw failure;
        },
        stopSession: () => {
          throw failure;
        },
      });
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
        credential.credentials,
      );
      const response = await routes[testCase.path]!.POST!(
        authorizedJsonRequest(testCase.path, credential.plaintext, {}),
      );
      const document = (await response.json()) as {
        error: { code: string; message: string; retryable: boolean };
      };

      expect(response.status).toBe(testCase.expectedStatus);
      expect(document.error.code).toBe(testCase.code);
      expect(document.error.retryable).toBe(testCase.retryable);
      expect(document.error.message).not.toContain('unsafe internal diagnostic');
    }
  });

  test('replays lifecycle mutations by key and rejects conflicting request content', async () => {
    const credential = await createCredential();
    const initialized = deferred<void>();
    let status = unconfiguredStatus();
    const initializeWallet = mock(async (input: { passphrase?: string }) => {
      await initialized.promise;
      const requiresPassphrase = Boolean(input.passphrase);
      status = {
        wallet: {
          configuredAt: '2026-08-16T00:00:00.000Z',
          mintUrl: 'https://mint.example.com',
        },
        seedAccess: {
          state: requiresPassphrase ? 'locked' : 'available',
          requiresPassphrase,
        },
        cocoSession: {
          state: requiresPassphrase ? 'stopped' : 'starting',
          startedAt: null,
          lastFailure: null,
        },
      };
      return {
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        requiresPassphrase,
      };
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(() => status, { initializeWallet }),
        '0.0.17',
      ),
      credential.credentials,
    );
    const request = () =>
      authorizedJsonRequest(
        '/v1/admin/wallet/initialize',
        credential.plaintext,
        { passphrase: 'correct horse' },
        undefined,
        { 'Idempotency-Key': 'initialize-wallet-1' },
      );

    const firstResponse = routes['/v1/admin/wallet/initialize']!.POST!(request());
    const concurrentReplay = routes['/v1/admin/wallet/initialize']!.POST!(request());
    await Promise.resolve();
    initialized.resolve();
    const [first, concurrent] = await Promise.all([firstResponse, concurrentReplay]);
    const firstBody = await first.json();
    const concurrentBody = await concurrent.json();

    expect(initializeWallet).toHaveBeenCalledTimes(1);
    expect(concurrent.status).toBe(201);
    expect(concurrentBody).toEqual(firstBody);

    const completedReplay = await routes['/v1/admin/wallet/initialize']!.POST!(request());
    expect(completedReplay.status).toBe(201);
    expect(await completedReplay.json()).toEqual(firstBody);
    expect(initializeWallet).toHaveBeenCalledTimes(1);

    const conflict = await routes['/v1/admin/wallet/initialize']!.POST!(
      authorizedJsonRequest('/v1/admin/wallet/initialize', credential.plaintext, {}, undefined, {
        'Idempotency-Key': 'initialize-wallet-1',
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: 'idempotency_key_conflict', retryable: false },
    });
    expect(initializeWallet).toHaveBeenCalledTimes(1);
  });

  test('returns stable authentication and capability errors without legacy envelopes', async () => {
    const credential = await createCredential();
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/status']!.GET!(
      new Request('http://localhost/v1/status'),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
    expect(await unauthenticated.json()).toEqual({
      error: {
        code: 'unauthenticated',
        message: 'A valid Client Credential is required',
        retryable: false,
      },
    });

    const invalidCredential = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', 'x'.repeat(43)),
    );
    expect(invalidCredential.status).toBe(401);
    expect(await invalidCredential.json()).toMatchObject({
      error: { code: 'unauthenticated', retryable: false },
    });

    await setCapabilities(credential.verifierFile, ['wallet:admin']);
    const forbidden = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'The Client Credential lacks the required capability',
        retryable: false,
      },
    });
  });

  test('rejects a route declaration that leaves a /v1 resource unauthenticated', async () => {
    const credential = await createCredential();
    const route = defineV1Route({
      method: 'GET',
      path: '/v1/public-by-mistake',
      capability: null,
      requestSchema: {
        name: 'NoBody',
        jsonSchema: { type: 'null' },
        parse: () => null,
      },
      responseSchema: {
        name: 'Ok',
        jsonSchema: { type: 'object' },
        parse: () => ({ ok: true }),
      },
      handler: async () => ({ ok: true }),
    });

    expect(() => buildV1Routes([route], credential.credentials)).toThrow(
      'V1 route GET /v1/public-by-mistake must require a capability',
    );
  });

  test('validates input and output and maps failures to stable errors', async () => {
    const credential = await createCredential();
    const requestSchema: RuntimeSchema<{ label: string }> = {
      name: 'TestRequest',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: { label: { type: 'string' } },
      },
      parse(value) {
        if (!isRecord(value) || typeof value.label !== 'string') {
          throw new Error('label must be a string');
        }
        return { label: value.label };
      },
    };
    const responseSchema: RuntimeSchema<{ accepted: boolean }> = {
      name: 'TestResponse',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['accepted'],
        properties: { accepted: { type: 'boolean' } },
      },
      parse(value) {
        if (!isRecord(value) || typeof value.accepted !== 'boolean') {
          throw new Error('accepted must be a boolean');
        }
        return { accepted: value.accepted };
      },
    };
    const route = defineV1Route<{ label: string }, { accepted: boolean }>({
      method: 'POST',
      path: '/v1/test',
      capability: 'wallet:admin',
      requestSchema,
      responseSchema,
      handler: async () => ({ accepted: true }),
    });
    const routes = buildV1Routes([route], credential.credentials);

    const malformed = await routes['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential.plaintext}` },
        body: '{not-json',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request body is not valid JSON',
        retryable: false,
      },
    });

    const invalid = await routes['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 21 }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_request', retryable: false },
    });

    const invalidOutput = buildV1Routes(
      [{ ...route, handler: async () => ({ accepted: 'yes' }) }],
      credential.credentials,
    );
    const failed = await invalidOutput['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'safe' }),
      }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'The request could not be completed',
        retryable: false,
      },
    });
  });

  test('redacts sensitive input fields in centralized request logs', async () => {
    const credential = await createCredential();
    const debug = mock((_event: string, _fields?: unknown) => {});
    const logger = createTestLogger({ debug });
    const requestSchema: RuntimeSchema<{ passphrase: string; label: string }> = {
      name: 'SensitiveRequest',
      jsonSchema: { type: 'object' },
      parse(value) {
        if (!isRecord(value) || typeof value.passphrase !== 'string') {
          throw new Error('invalid');
        }
        return { passphrase: value.passphrase, label: String(value.label) };
      },
    };
    const responseSchema: RuntimeSchema<{ ok: true }> = {
      name: 'Ok',
      jsonSchema: { type: 'object' },
      parse: () => ({ ok: true }),
    };
    const routes = buildV1Routes(
      [
        defineV1Route({
          method: 'POST',
          path: '/v1/sensitive',
          capability: 'wallet:admin',
          requestSchema,
          responseSchema,
          handler: async () => ({ ok: true }),
        }),
      ],
      credential.credentials,
      logger,
    );

    await routes['/v1/sensitive']!.POST!(
      new Request('http://localhost/v1/sensitive', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ passphrase: 'open sesame', label: 'visible' }),
      }),
    );

    expect(JSON.stringify(debug.mock.calls)).not.toContain('open sesame');
    expect(debug).toHaveBeenCalledWith('request.received', {
      input: { passphrase: '[REDACTED]', label: 'visible' },
    });
  });
});

function statusRuntime(status: CocodStatus): V1Runtime {
  return lifecycleRuntime(() => status);
}

function lifecycleRuntime(
  getStatus: () => CocodStatus,
  overrides: Partial<V1Runtime> = {},
): V1Runtime {
  return {
    getStatus,
    getRunningSession: () => null,
    initializeWallet: async () => {
      throw new Error('initializeWallet was not expected');
    },
    getWalletRecoveryMaterial: async () => {
      throw new Error('getWalletRecoveryMaterial was not expected');
    },
    startSession: () => {
      throw new Error('startSession was not expected');
    },
    stopSession: async () => {
      throw new Error('stopSession was not expected');
    },
    ...overrides,
  };
}

function unconfiguredStatus(): CocodStatus {
  return {
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  };
}

function configuredStatus(state: CocodStatus['cocoSession']['state']): CocodStatus {
  return {
    wallet: {
      configuredAt: '2026-08-16T00:00:00.000Z',
      mintUrl: 'https://mint.example.com',
    },
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: {
      state,
      startedAt: state === 'running' ? '2026-08-16T00:00:01.000Z' : null,
      lastFailure:
        state === 'failed'
          ? {
              code: 'session_start_failed',
              message: 'Coco Session failed to start',
              occurredAt: '2026-08-16T00:00:02.000Z',
            }
          : null,
    },
  };
}

async function createCredential(): Promise<{
  credentials: AdministrativeCredential;
  plaintext: string;
  verifierFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-http-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const currentDirectory = join(credentialDirectory, 'current');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  return {
    credentials,
    plaintext: await loadClientCredential(join(currentDirectory, 'client')),
    verifierFile: join(currentDirectory, 'verifier.json'),
  };
}

async function setCapabilities(path: string, capabilities: ClientCapability[]): Promise<void> {
  const state = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  state.capabilities = capabilities;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}

function authorizedRequest(path: string, credential: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

function authorizedJsonRequest(
  path: string,
  credential: string,
  body: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
