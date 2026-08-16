import { describe, expect, it, mock } from 'bun:test';

import { MintSwapOpsApi } from '../../api/MintSwapOpsApi.ts';
import { EventBus, type CoreEvents } from '../../events';
import type { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import { makePreparingMintSwapOperation } from '../fixtures/MintSwap.ts';

describe('MintSwapOpsApi', () => {
  it('accepts a persisted operation object when executing', async () => {
    const operation = makePreparingMintSwapOperation({ id: 'prepared' });
    const execute = mock(async () => operation);
    const service = { execute } as unknown as MintSwapOperationService;
    const api = new MintSwapOpsApi(service, new EventBus<CoreEvents>());

    await api.execute(operation);

    expect(execute).toHaveBeenCalledWith('prepared');
  });

  it('coalesces concurrent recovery runs and reconciles every active operation', async () => {
    const first = makePreparingMintSwapOperation({ id: 'first' });
    const second = makePreparingMintSwapOperation({ id: 'second' });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = mock(async (_operationId: string) => {
      await blocked;
      return first;
    });
    const service = {
      listActive: mock(async () => [first, second]),
      reconcile,
    } as unknown as MintSwapOperationService;
    const api = new MintSwapOpsApi(service, new EventBus<CoreEvents>());

    const one = api.recovery.run();
    const two = api.recovery.run();
    expect(api.recovery.inProgress()).toBe(true);
    expect(one).toBe(two);
    release();
    await one;

    expect(reconcile.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
    expect(api.recovery.inProgress()).toBe(false);
  });

  it('keeps diagnostics available while rejecting commands without persistence capability', () => {
    const api = new MintSwapOpsApi(undefined, new EventBus<CoreEvents>());

    expect(api.diagnostics.isAvailable()).toBe(false);
    expect(() => api.listActive()).toThrow(
      'Mint Swap requires the optional durable repository capability',
    );
  });
});
