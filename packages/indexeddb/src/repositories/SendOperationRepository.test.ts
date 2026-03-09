/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { IdbSendOperationRepository } from './SendOperationRepository.ts';
import type { SendOperationRow } from '../lib/db.ts';

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

    const repository = new IdbSendOperationRepository({
      table: () => ({
        get: async () => row,
      }),
    } as any);

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
});
