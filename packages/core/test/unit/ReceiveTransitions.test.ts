import { describe, expect, it } from 'bun:test';
import {
  beginReceiveExecution,
  prepareReceive,
} from '../../operations/receive/ReceiveTransitions.ts';
import {
  createReceiveEnvironment,
  receiveKeys,
  receiveMint,
  receiveToken,
} from '../fixtures/ReceiveEnvironment.ts';
import { testMintKeypairs } from '../fixtures/MintMetadata.ts';

describe('Receive transition composition', () => {
  it.each([false, true])(
    'rolls back preparation and counters when a later authorization fails (caught: %s)',
    async (catchFailure) => {
      const env = await createReceiveEnvironment();
      const operation = await env.service.init(receiveToken());
      const input = {
        operation,
        activeKeys: { id: receiveKeys, unit: 'sat', keys: testMintKeypairs },
        seed: await env.loadSeed(),
        updatedAt: Date.now(),
      };
      const counter = await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys);
      await expect(
        env.transactionRunner.run(async (tx) => {
          await tx.perform(prepareReceive, input);
          const failure = tx.perform(beginReceiveExecution, {
            operationId: 'missing',
            updatedAt: input.updatedAt,
          });
          if (catchFailure) await failure.catch(() => {});
          else await failure;
        }),
      ).rejects.toThrow('not found');
      expect(await env.service.getOperation(operation.id)).toBeNull();
      expect(await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys)).toEqual(
        counter,
      );
      expect(env.remote.receive).not.toHaveBeenCalled();
    },
  );

  it('prepares and authorizes within one transaction', async () => {
    const env = await createReceiveEnvironment();
    const operation = await env.service.init(receiveToken());
    const input = {
      operation,
      activeKeys: { id: receiveKeys, unit: 'sat', keys: testMintKeypairs },
      seed: await env.loadSeed(),
      updatedAt: Date.now(),
    };
    const executing = await env.transactionRunner.run(async (tx) => {
      await tx.perform(prepareReceive, input);
      return tx.perform(beginReceiveExecution, {
        operationId: operation.id,
        updatedAt: input.updatedAt,
      });
    });
    expect(executing.state).toBe('executing');
    expect(await env.service.getOperation(operation.id)).toEqual(executing);
    expect(env.remote.receive).not.toHaveBeenCalled();
  });
});
