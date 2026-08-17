import { describe, expect, it } from 'bun:test';

import { EventBus, type CoreEvents } from '../../events';
import {
  MintSwapSettlementError,
  waitForMintSwapSettlement,
} from '../../operations/mintSwap/MintSwapWaiter.ts';
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation.ts';
import {
  makeMintSwapOutboxRecord,
  makePreparingMintSwapOperation,
  makeSettledMintSwapOperation,
} from '../fixtures/MintSwap.ts';

describe('waitForMintSwapSettlement', () => {
  it('subscribes before its confirming read and resolves a concurrent completion', async () => {
    const bus = new EventBus<CoreEvents>();
    const completed = makeSettledMintSwapOperation({ state: 'completed' });
    let current: MintSwapOperation = makePreparingMintSwapOperation();
    let emitted = false;
    const service = {
      get: async () => {
        current = completed;
        if (!emitted) {
          emitted = true;
          await bus.emit(
            'mint-swap-op:completed',
            makeMintSwapOutboxRecord({
              operationId: completed.id,
              revision: completed.revision,
              eventType: 'mint-swap-op:completed',
              payload: {
                operationId: completed.id,
                revision: completed.revision,
                state: 'completed',
                sourceMintUrl: completed.sourceMintUrl,
                destinationMintUrl: completed.destinationMintUrl,
                unit: 'sat',
                destinationAmount: completed.destinationAmount.toString(),
              },
            }).payload,
          );
        }
        return current;
      },
    };

    await expect(waitForMintSwapSettlement(service, bus, completed.id)).resolves.toEqual(completed);
  });

  for (const state of ['cancelled', 'failed', 'needs_attention'] as const) {
    it(`rejects with a typed ${state} outcome`, async () => {
      const operation = makePreparingMintSwapOperation({
        state,
        preparationLease: undefined,
        ...(state === 'cancelled' ? { cancelledAt: 1_700_000_000_000 } : {}),
        ...(state === 'failed'
          ? {
              terminalFailure: {
                code: 'test',
                reason: 'Test failure',
                at: 1_700_000_000_000,
              },
            }
          : {}),
        ...(state === 'needs_attention'
          ? {
              attention: {
                reason: 'accounting_mismatch',
                message: 'Test attention',
                lastSafeState: 'preparing',
                violatedInvariant: 'test',
                evidence: {},
                at: 1_700_000_000_000,
              },
            }
          : {}),
      });
      try {
        await waitForMintSwapSettlement(
          { get: async () => operation },
          new EventBus(),
          operation.id,
        );
        throw new Error('Expected waiter to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(MintSwapSettlementError);
        expect((error as MintSwapSettlementError).outcome).toBe(state);
      }
    });
  }

  it('aborts and removes listeners', async () => {
    const bus = new EventBus<CoreEvents>();
    const controller = new AbortController();
    const waiting = waitForMintSwapSettlement(
      { get: async () => makePreparingMintSwapOperation() },
      bus,
      'mint-swap-op',
      { signal: controller.signal },
    );
    controller.abort(new Error('stop waiting'));
    await expect(waiting).rejects.toThrow('stop waiting');
  });
});
