import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import {
  LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX,
  planLegacyMintOperationMigration,
  type LegacyMintOperationMigrationRecord,
} from '../../repositories/LegacyMintOperationMigration.ts';

const outputData = (keysetId: string, suffix: string) => ({
  keep: [
    {
      blindedMessage: { amount: '1', id: keysetId, B_: `B_${suffix}` },
      blindingFactor: suffix,
      secret: suffix,
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
    const plan = planLegacyMintOperationMigration(
      [
        operation('pending', 'pending', { createdAt: 1_000 }),
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
      ],
      [{ mintUrl: 'https://mint.test', keysetId: 'keyset-1', counter: 10 }],
    );

    expect(plan.map(({ attempt }) => attempt.state)).toEqual([
      'prepared',
      'recovering',
      'succeeded',
      'failed',
    ]);
    expect(plan.map(({ operationState }) => operationState)).toEqual([
      'executing',
      'executing',
      'finalized',
      'failed',
    ]);
    expect(plan.map(({ attempt }) => [attempt.counterStart, attempt.counterEnd])).toEqual([
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
    ]);
    expect(plan[0]!.attempt).toMatchObject({
      id: `${LEGACY_MINT_ISSUANCE_ATTEMPT_PREFIX}pending`,
      mintUrl: 'https://mint.test',
      unit: 'sat',
      keysetId: 'keyset-1',
      memberOperationIds: ['pending'],
      quoteIds: ['quote-pending'],
      request: { kind: 'single', quoteId: 'quote-pending' },
    });
    expect(plan[0]!.attempt.quoteAmounts.map(String)).toEqual(['1']);
    expect(plan[0]!.attempt.outputData).toEqual(outputData('keyset-1', 'pending'));
    expect(plan[3]!.attempt.terminalError).toEqual({
      message: 'quote expired',
      code: 'QUOTE_EXPIRED',
      details: { retryable: false, observedAt: 1_900 },
    });
  });

  it('leaves init, output-less, and already attached operations unchanged', () => {
    const plan = planLegacyMintOperationMigration(
      [
        operation('init', 'init', { outputData: undefined }),
        operation('pending-empty', 'pending', { outputData: { keep: [], send: [] } }),
        operation('attached', 'executing', { attemptId: 'existing-attempt' }),
      ],
      [{ mintUrl: 'https://mint.test', keysetId: 'keyset-1', counter: 10 }],
    );

    expect(plan).toEqual([]);
  });

  it('rejects ambiguous keysets and counter ranges that cannot cover legacy outputs', () => {
    const mixedKeysets = operation('mixed', 'executing', {
      outputData: {
        keep: outputData('keyset-1', 'one').keep,
        send: outputData('keyset-2', 'two').keep,
      },
    });

    expect(() =>
      planLegacyMintOperationMigration(
        [mixedKeysets],
        [{ mintUrl: 'https://mint.test', keysetId: 'keyset-1', counter: 10 }],
      ),
    ).toThrow('multiple keysets');
    expect(() =>
      planLegacyMintOperationMigration(
        [operation('too-many', 'executing')],
        [{ mintUrl: 'https://mint.test', keysetId: 'keyset-1', counter: 0 }],
      ),
    ).toThrow('cannot cover');
  });
});
