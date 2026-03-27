/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { IdbSendOperationRepository } from './SendOperationRepository.ts';
import type { SendOperationRow } from '../lib/db.ts';

function createDbStub(row: SendOperationRow | undefined) {
  return {
    runTransaction: async (
      _mode: 'r' | 'rw',
      _stores: string[],
      fn: (tx: any) => Promise<unknown>,
    ) =>
      fn({
        table: () => ({
          get: async () => row,
        }),
      }),
  };
}

describe('IdbSendOperationRepository', () => {
  it('loads legacy rows that only have methodData', async () => {
    const row = {
      id: 'op-1',
      mintUrl: 'https://mint.test',
      amount: 100,
      state: 'init',
      createdAt: 1,
      updatedAt: 2,
      error: null,
      method: 'default',
      methodData: {},
    } as SendOperationRow & {
      methodData?: Record<string, never>;
      methodDataJson?: string;
    };

    const repository = new IdbSendOperationRepository(createDbStub(row) as any);

    await expect(repository.getById('op-1')).resolves.toEqual({
      id: 'op-1',
      mintUrl: 'https://mint.test',
      amount: 100,
      state: 'init',
      createdAt: 1000,
      updatedAt: 2000,
      error: undefined,
      method: 'default',
      methodData: {},
    });
  });

  it('loads persisted token data for pending P2PK operations', async () => {
    const row = {
      id: 'op-p2pk',
      mintUrl: 'https://mint.test',
      amount: 100,
      state: 'pending',
      createdAt: 1,
      updatedAt: 2,
      error: null,
      method: 'p2pk',
      methodDataJson: JSON.stringify({ pubkey: '02' + '11'.repeat(32) }),
      needsSwap: 1,
      fee: 1,
      inputAmount: 101,
      inputProofSecretsJson: JSON.stringify(['secret-1']),
      outputDataJson: JSON.stringify({ keep: [], send: [] }),
      tokenJson: JSON.stringify({
        mint: 'https://mint.test',
        proofs: [{ id: 'keyset-1', amount: 100, secret: 'send-secret', C: 'C_send' }],
        unit: 'sat',
      }),
    } satisfies SendOperationRow;

    const repository = new IdbSendOperationRepository(createDbStub(row) as any);

    await expect(repository.getById('op-p2pk')).resolves.toEqual({
      id: 'op-p2pk',
      mintUrl: 'https://mint.test',
      amount: 100,
      state: 'pending',
      createdAt: 1000,
      updatedAt: 2000,
      error: undefined,
      method: 'p2pk',
      methodData: { pubkey: '02' + '11'.repeat(32) },
      needsSwap: true,
      fee: 1,
      inputAmount: 101,
      inputProofSecrets: ['secret-1'],
      outputData: { keep: [], send: [] },
      token: {
        mint: 'https://mint.test',
        proofs: [{ id: 'keyset-1', amount: 100, secret: 'send-secret', C: 'C_send' }],
        unit: 'sat',
      },
    });
  });
});
