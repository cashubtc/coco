import { Amount, type PaymentRequestPayload } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import type {
  PaymentRequestReceiveAttempt,
  ParsedPaymentRequestPayload,
} from '../../operations/paymentRequestReceive/PaymentRequestReceiveOperation.ts';
import { PaymentRequestReceiveTransportHandlerProvider } from '../../infra/handlers/paymentRequestReceive';
import { MemoryPaymentRequestReceiveAttemptRepository } from '../../repositories/memory';
import { PaymentRequestReceiveService } from '../../services/PaymentRequestReceiveService.ts';
import type { MintService } from '../../services/MintService.ts';
import {
  createReceiveEnvironment,
  receiveInput,
  receiveKeysetId,
  receiveMintUrl,
} from '../fixtures/ReceiveEnvironment.ts';

class ObservedAttempts extends MemoryPaymentRequestReceiveAttemptRepository {
  beforeLink?: () => Promise<void>;
  afterLink?: (attempt: PaymentRequestReceiveAttempt) => Promise<void>;
  override async update(attempt: PaymentRequestReceiveAttempt): Promise<void> {
    if (attempt.state === 'receiving') await this.beforeLink?.();
    await super.update(attempt);
    if (attempt.state === 'receiving') await this.afterLink?.(attempt);
  }
}

async function environment(attempts = new ObservedAttempts()) {
  const receive = await createReceiveEnvironment();
  const operations = receive.repositories.paymentRequestReceiveOperationRepository;
  const service = new PaymentRequestReceiveService(
    operations,
    attempts,
    receive.service,
    receive.repositories.receiveOperationRepository,
    { isTrustedMint: async () => true } as unknown as MintService,
    new PaymentRequestReceiveTransportHandlerProvider(),
  );
  return { receive, operations, attempts, service };
}

const payload: PaymentRequestPayload = {
  id: 'request',
  mint: receiveMintUrl,
  unit: 'sat',
  proofs: [receiveInput()],
};

async function start(env: Awaited<ReturnType<typeof environment>>, path: 'claim' | 'recovery') {
  const operation = await env.service.create({
    requestId: payload.id,
    amount: Amount.from(10),
    unit: 'sat',
    mints: [receiveMintUrl],
  });
  if (path === 'claim') return env.service.claimPayload(operation.id, payload);
  const payloadHash = (
    env.service as unknown as { hashPayload(payload: ParsedPaymentRequestPayload): string }
  ).hashPayload(payload);
  await env.attempts.create({
    id: 'interrupted-attempt',
    requestOperationId: operation.id,
    requestId: operation.requestId,
    transport: 'inband',
    payloadHash,
    mintUrl: receiveMintUrl,
    unit: 'sat',
    grossAmount: Amount.from(10),
    state: 'validating',
    payload,
    createdAt: 1,
    updatedAt: 1,
  });
  await env.service.recoverPendingAttempts();
}

describe('Payment Request Receive durable child linkage', () => {
  it.each(['claim', 'recovery'] as const)(
    'recovers a crash immediately after %s links its child without redelivery',
    async (path) => {
      const env = await environment();
      let checkpoint: Awaited<ReturnType<typeof environment>> | undefined;
      let childId: string | undefined;
      let attemptId: string | undefined;
      env.attempts.afterLink = async (attempt) => {
        if (checkpoint) return;
        // Copy only what was durable at the first receiving-state write into a fresh session.
        checkpoint = await environment();
        const operation = await env.operations.getById(attempt.requestOperationId);
        await checkpoint.operations.create(operation!);
        await checkpoint.attempts.create((await env.attempts.getById(attempt.id))!);
        const child = await env.receive.repositories.receiveOperationRepository.getById(
          attempt.receiveOperationId!,
        );
        if (child) await checkpoint.receive.repositories.receiveOperationRepository.create(child);
        const counter = await env.receive.repositories.counterRepository.getCounter(
          receiveMintUrl,
          receiveKeysetId,
        );
        if (counter)
          await checkpoint.receive.repositories.counterRepository.setCounter(
            receiveMintUrl,
            receiveKeysetId,
            counter.counter,
          );
        childId = attempt.receiveOperationId;
        attemptId = attempt.id;
      };
      await start(env, path);
      if (!checkpoint) throw new Error('Link checkpoint was not reached');
      await checkpoint.service.recoverPendingAttempts();
      const recovered = await checkpoint.attempts.getById(attemptId!);
      expect(recovered?.state).toBe('finalized');
      expect(recovered?.receiveOperationId).toBe(childId);
      expect(checkpoint.receive.remote.receive).toHaveBeenCalledTimes(1);
      expect(checkpoint.receive.loadSeed).not.toHaveBeenCalled();
      expect(
        (await checkpoint.receive.repositories.receiveOperationRepository.getById(childId!))?.state,
      ).toBe('finalized');
    },
  );

  it.each(['claim', 'recovery'] as const)(
    'keeps a prepared child discoverable when %s cannot persist its link',
    async (path) => {
      const env = await environment();
      env.attempts.beforeLink = async () => {
        throw new Error('link persistence failed');
      };
      if (path === 'claim')
        await expect(start(env, path)).rejects.toThrow('link persistence failed');
      else await start(env, path);
      const attempts = await env.attempts.getByState('validating');
      expect(attempts).toHaveLength(1);
      const child =
        await env.receive.repositories.receiveOperationRepository.getByPaymentRequestAttemptId(
          attempts[0]!.id,
        );
      expect(child?.state).toBe('prepared');
      expect(env.receive.remote.receive).not.toHaveBeenCalled();
      const counter = await env.receive.repositories.counterRepository.getCounter(
        receiveMintUrl,
        receiveKeysetId,
      );
      env.attempts.beforeLink = undefined;
      await env.service.recoverPendingAttempts();
      const recovered = await env.attempts.getById(attempts[0]!.id);
      expect(recovered?.state).toBe('finalized');
      expect(recovered?.receiveOperationId).toBe(child?.id);
      expect(env.receive.remote.receive).toHaveBeenCalledTimes(1);
      expect(
        await env.receive.repositories.counterRepository.getCounter(
          receiveMintUrl,
          receiveKeysetId,
        ),
      ).toEqual(counter);
    },
  );
});
