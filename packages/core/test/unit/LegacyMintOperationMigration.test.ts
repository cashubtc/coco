import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import {
  decodeLegacyMintOperationMigrationRecord,
  LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX,
  planLegacyMintOperationMigration,
  serializeLegacyMintIssuanceAttempt,
  type LegacyMintOperationMigrationRecord,
} from '../../repositories/LegacyMintOperationMigration.ts';

const outputData = (keysetId: string, suffix: string) => ({
  keep: [
    {
      blindedMessage: { amount: '1', id: keysetId, B_: `B_${suffix}` },
      blindingFactor: '1',
      secret: Array.from(suffix, (character) =>
        character.charCodeAt(0).toString(16).padStart(2, '0'),
      ).join(''),
    },
  ],
  send: [],
});

function operation(
  id: string,
  state: LegacyMintOperationMigrationRecord['state'],
  overrides: Partial<LegacyMintOperationMigrationRecord> = {},
): LegacyMintOperationMigrationRecord {
  return {
    id,
    mintUrl: 'https://MINT.test/',
    quoteId: `quote-${id}`,
    method: 'bolt11',
    unit: 'SAT',
    amount: Amount.from(1),
    state,
    outputData: outputData('keyset-1', id),
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe('planLegacyMintOperationMigration', () => {
  it('maps legacy lifecycle states into single-member attempts without changing counters', () => {
    const plan = planLegacyMintOperationMigration([
      operation('executing', 'executing', { createdAt: 2_000 }),
      operation('finalized', 'finalized', { createdAt: 3_000 }),
      operation('failed', 'failed', {
        createdAt: 4_000,
        error: 'quote expired',
        terminalFailure: {
          reason: 'quote expired',
          code: 'QUOTE_EXPIRED',
          retryable: false,
          observedAt: 1_900,
        },
      }),
    ]);

    expect(plan.map(({ attempt }) => attempt.state)).toEqual(['recovering', 'succeeded', 'failed']);
    expect(plan.map(({ operationState }) => operationState)).toEqual([
      'executing',
      'finalized',
      'failed',
    ]);
    expect(plan.every(({ attempt }) => attempt.counterStart === undefined)).toBe(true);
    expect(plan.every(({ attempt }) => attempt.counterEnd === undefined)).toBe(true);
    expect(plan[0]!.attempt).toMatchObject({
      id: `${LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX}executing`,
      mintUrl: 'https://mint.test',
      unit: 'sat',
      keysetId: 'keyset-1',
      memberOperationIds: ['executing'],
      quoteIds: ['quote-executing'],
      request: { kind: 'single', quoteId: 'quote-executing' },
    });
    expect(plan[0]!.attempt.quoteAmounts.map(String)).toEqual(['1']);
    expect(plan[0]!.attempt.outputData).toEqual(outputData('keyset-1', 'executing'));
    expect(plan[2]!.attempt.terminalError).toEqual({
      message: 'quote expired',
      code: 'QUOTE_EXPIRED',
      details: { retryable: false, observedAt: 1_900 },
    });
  });

  it('leaves init, pending, output-less, and already attached operations unchanged', () => {
    const plan = planLegacyMintOperationMigration([
      operation('init', 'init', { outputData: undefined }),
      operation('pending', 'pending'),
      operation('pending-empty', 'pending', { outputData: { keep: [], send: [] } }),
      operation('attached', 'executing', { attemptId: 'existing-attempt' }),
    ]);

    expect(plan).toEqual([]);
  });

  it('rejects ambiguous keysets without inferring a historical counter range', () => {
    const mixedKeysets = operation('mixed', 'executing', {
      outputData: {
        keep: outputData('keyset-1', 'one').keep,
        send: outputData('keyset-2', 'two').keep,
      },
    });

    expect(() => planLegacyMintOperationMigration([mixedKeysets])).toThrow('multiple keysets');
  });

  it('decodes persisted fields strictly and preserves optional init data', () => {
    const decoded = decodeLegacyMintOperationMigrationRecord({
      id: 'pending',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-pending',
      method: 'bolt12',
      unit: 'sat',
      amount: '1',
      state: 'pending',
      outputDataJson: JSON.stringify(outputData('keyset-1', 'pending')),
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(decoded).toMatchObject({ id: 'pending', method: 'bolt12', quoteId: 'quote-pending' });
    expect(String(decoded.amount)).toBe('1');

    expect(
      decodeLegacyMintOperationMigrationRecord({
        id: 'init',
        mintUrl: 'https://mint.test',
        state: 'init',
        createdAt: 1_000,
        updatedAt: 2_000,
      }),
    ).toMatchObject({ id: 'init', state: 'init' });
  });

  it('rejects missing attempt data and corrupt persisted JSON', () => {
    expect(() =>
      planLegacyMintOperationMigration([
        operation('missing-quote', 'executing', { quoteId: undefined }),
      ]),
    ).toThrow('missing required attempt data');

    expect(() =>
      decodeLegacyMintOperationMigrationRecord({
        id: 'corrupt',
        mintUrl: 'https://mint.test',
        state: 'pending',
        outputDataJson: '{',
        createdAt: 1_000,
        updatedAt: 2_000,
      }),
    ).toThrow('invalid outputDataJson');
  });

  it('decodes terminal failure metadata and serializes its migrated attempt', () => {
    const outputDataJson = JSON.stringify(outputData('keyset-1', 'failed'));
    const decoded = decodeLegacyMintOperationMigrationRecord({
      id: 'failed',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-failed',
      method: 'onchain',
      unit: 'sat',
      amount: '1',
      state: 'failed',
      outputDataJson,
      createdAt: 1_000,
      updatedAt: 2_000,
      error: 'legacy error',
      terminalFailureJson: JSON.stringify({
        reason: 'quote expired',
        code: 'QUOTE_EXPIRED',
        retryable: false,
        observedAt: 1_900,
      }),
    });

    expect(decoded.terminalFailure).toEqual({
      reason: 'quote expired',
      code: 'QUOTE_EXPIRED',
      retryable: false,
      observedAt: 1_900,
    });

    const [{ attempt } = {}] = planLegacyMintOperationMigration([decoded]);
    expect(attempt).toBeDefined();
    expect(serializeLegacyMintIssuanceAttempt(attempt!, outputDataJson)).toEqual({
      quoteIdsJson: '["quote-failed"]',
      quoteAmountsJson: '["1"]',
      signingRequirementsJson: '[null]',
      outputDataJson,
      requestJson: '{"kind":"single","quoteId":"quote-failed"}',
      terminalErrorJson:
        '{"message":"quote expired","code":"QUOTE_EXPIRED","details":{"retryable":false,"observedAt":1900}}',
    });
  });
});
