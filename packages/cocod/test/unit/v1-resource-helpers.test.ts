import { describe, expect, test } from 'bun:test';

import type { CocodStatus } from '../../src/runtime.js';
import {
  buildV1Routes,
  defineV1Route,
  noBodySchema,
  V1HttpError,
  type V1Runtime,
} from '../../src/v1/http.js';
import type { AdministrativeCredential } from '../../src/credentials.js';
import {
  defineResourceRoute,
  normalizeRequestMintUrl,
  paginate,
  pathIdentifier,
  queryMintUrl,
  queryMintUrls,
  requireRunningSession,
} from '../../src/v1/resources/shared.js';

// Host lifecycle inputs form a state table; no Coco services are replaced here.
function unavailableRuntime(status: CocodStatus): V1Runtime {
  const unexpected = (): never => {
    throw new Error('Unexpected lifecycle mutation');
  };
  return {
    getStatus: () => status,
    getRunningSession: () => null,
    initializeWallet: unexpected,
    getWalletRecoveryMaterial: unexpected,
    startSession: unexpected,
    stopSession: unexpected,
  };
}

describe('shared resource availability', () => {
  test('maps every unavailable host state, including the idempotent binding guard', () => {
    const configured: CocodStatus = {
      wallet: { configuredAt: '2026-08-16T00:00:00.000Z', mintUrl: 'https://mint.example' },
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    };
    const cases: Array<[CocodStatus, number, string, boolean]> = [
      [{ ...configured, wallet: null, seedAccess: null }, 409, 'wallet_not_configured', false],
      [configured, 503, 'session_stopped', false],
      [
        { ...configured, seedAccess: { state: 'locked', requiresPassphrase: true } },
        423,
        'wallet_locked',
        false,
      ],
      ...(['starting', 'stopping', 'failed'] as const).map(
        (state): [CocodStatus, number, string, boolean] => [
          { ...configured, cocoSession: { ...configured.cocoSession, state } },
          503,
          state === 'failed' ? 'session_restart_required' : 'session_transition_in_progress',
          state !== 'failed',
        ],
      ),
    ];
    const route = defineResourceRoute({
      method: 'POST',
      path: '/v1/test',
      capability: 'wallet:admin',
      requestSchema: noBodySchema,
      responseSchema: noBodySchema,
      idempotencyKey: 'optional',
      handler: (_input, _context, { runtime }) => {
        requireRunningSession(runtime);
        return null;
      },
    });
    for (const [status, httpStatus, code, retryable] of cases) {
      const runtime = unavailableRuntime(status);
      const bound = route.bind({ runtime, daemonVersion: 'test', eventKeepAliveIntervalMs: 5_000 });
      expect(bound.assertAvailable).toBeDefined();
      for (const check of [() => requireRunningSession(runtime), () => bound.assertAvailable!()]) {
        let failure: unknown;
        try {
          check();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(V1HttpError);
        expect((failure as V1HttpError).options).toMatchObject({
          status: httpStatus,
          code,
          retryable,
        });
        expect((failure as V1HttpError).options.headers).toEqual(
          retryable ? { 'Retry-After': '1' } : undefined,
        );
      }
    }
  });
});

test('route construction rejects missing, extra, and duplicate parameter declarations', () => {
  const definition = defineV1Route({
    method: 'GET',
    path: '/v1/test/{id}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: noBodySchema,
    handler: () => null,
  });
  // Construction must fail before it needs a credential verifier.
  const credentials = {} as AdministrativeCredential;
  expect(() => buildV1Routes([definition], credentials)).toThrow('mismatched path parameters');
  const valid = { ...definition, parameters: { id: pathIdentifier('ID') } };
  expect(() => buildV1Routes([{ ...valid, path: '/v1/test' }], credentials)).toThrow(
    'mismatched path parameters',
  );
  expect(() => buildV1Routes([valid, valid], credentials)).toThrow('defined twice');
});

test('Mint URL helpers normalize identity and reject credentials and non-HTTP URLs', () => {
  expect(normalizeRequestMintUrl('https://mint.example/')).toBe('https://mint.example');
  expect(queryMintUrls('Mints').parse(['https://mint.example/', 'http://localhost:3338/'])).toEqual(
    ['https://mint.example', 'http://localhost:3338'],
  );
  for (const value of ['mint.example', 'ftp://mint.example', 'https://user:secret@mint.example']) {
    expect(() => queryMintUrl('Mint').parse([value])).toThrow();
  }
});

test('pagination sorts newest first with a stable ID tie-breaker without mutating input', () => {
  const rows = [
    { id: 'b', createdAt: 2 },
    { id: 'old', createdAt: 1 },
    { id: 'a', createdAt: 2 },
  ];
  expect(
    paginate(
      rows,
      (row) => row,
      (row) => row.id,
      { offset: 1, limit: 2 },
    ),
  ).toEqual({
    items: ['b', 'old'],
    offset: 1,
    limit: 2,
  });
  expect(rows.map((row) => row.id)).toEqual(['b', 'old', 'a']);
});
