import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, spyOn } from 'bun:test';
import { PaymentRequestReceiveService } from '../../services/PaymentRequestReceiveService.ts';
import { PaymentRequestReceiveTransportHandlerProvider } from '../../infra/handlers/paymentRequestReceive/index.ts';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository.ts';
import {
  createReceiveEnvironment,
  receiveKeys,
  receiveMint,
  receiveToken,
} from '../fixtures/ReceiveEnvironment.ts';
import { createMintServiceForMetadata } from '../fixtures/MintMetadataRefresh.ts';
import { testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

async function createParent() {
  const env = await createReceiveEnvironment();
  const repos = env.repositories;
  const parent = new PaymentRequestReceiveService(
    env.transactionRunner,
    repos.paymentRequestReceiveOperationRepository,
    repos.paymentRequestReceiveAttemptRepository,
    env.service,
    env.preparation,
    createMintServiceForMetadata(repos),
    new PaymentRequestReceiveTransportHandlerProvider(),
  );
  return { env, repos, parent };
}

describe('Payment Request Receive child persistence', () => {
  it('claims a fresh payment without searching historical Receive sources', async () => {
    const { parent, env } = await createParent();
    const request = await parent.create({ amount: 7, requestId: 'request' });
    const lookup = spyOn(
      MemoryReceiveOperationRepository.prototype,
      'getByPaymentRequestAttemptId',
    );
    try {
      const result = await parent.claimPayload(request, {
        ...receiveToken(),
        id: request.requestId,
        unit: 'sat',
      });
      expect(result.attempt.state).toBe('finalized');
      expect(lookup).not.toHaveBeenCalled();
      expect(env.remote.receive).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });

  for (const entry of ['claim', 'restart'] as const) {
    it(`keeps a payment retryable when the output keyset rotates during ${entry}`, async () => {
      const { parent, env, repos } = await createParent();
      const request = await parent.create({ amount: 7, requestId: 'request' });
      const payload = { ...receiveToken(), id: request.requestId, unit: 'sat' };
      const attempts = repos.paymentRequestReceiveAttemptRepository;
      let interruptedAttemptId: string | undefined;
      if (entry === 'restart') {
        // Keep the durable checkpoint a process exit during seed loading would leave.
        let checkpoint: Awaited<ReturnType<typeof attempts.getById>> = null;
        env.loadSeed.mockImplementationOnce(async () => {
          [checkpoint = null] = await attempts.getByRequestOperationId(request.id);
          interruptedAttemptId = checkpoint?.id;
          throw new Error('Interrupted');
        });
        await expect(parent.claimPayload(request, payload)).rejects.toThrow('Interrupted');
        if (!checkpoint) throw new Error('Missing delivery checkpoint');
        await attempts.create(checkpoint);
      }
      const newKeyset = testMintKeysetId('sat', { input_fee_ppk: 100 });
      env.loadSeed.mockImplementationOnce(async () => {
        // Another session commits the rotation after preparation selected its output keys.
        await repos.withTransaction(async (tx) => {
          await tx.keysetRepository.updateKeyset({
            mintUrl: receiveMint,
            id: receiveKeys,
            unit: 'sat',
            active: false,
            feePpk: 0,
          });
          await tx.keysetRepository.addKeyset({
            mintUrl: receiveMint,
            id: newKeyset,
            unit: 'sat',
            active: true,
            feePpk: 100,
            keypairs: testMintKeypairs,
          });
        });
        return new Uint8Array(32).fill(1);
      });
      if (entry === 'claim') {
        await expect(parent.claimPayload(request, payload)).rejects.toThrow(
          'changed after preflight',
        );
        expect(await attempts.getByRequestOperationId(request.id)).toHaveLength(0);
      } else {
        await parent.recoverPendingAttempts();
        const [retained] = await attempts.getByRequestOperationId(request.id);
        expect(retained?.state).toBe('validating');
        expect(retained?.payload).toBeDefined();
      }
      expect(env.remote.receive).not.toHaveBeenCalled();
      expect(await repos.receiveOperationRepository.getByMintUrl(receiveMint)).toHaveLength(0);
      if (entry === 'restart') {
        await parent.recoverPendingAttempts();
        const [recovered] = await attempts.getByRequestOperationId(request.id);
        expect(recovered?.id).toBe(interruptedAttemptId);
        expect(recovered?.state).toBe('finalized');
      }
      const paid = await parent.claimPayload(request, payload);
      expect(paid.attempt.state).toBe('finalized');
      expect(paid.attempt.netAmount?.toString()).toBe('7');
      expect(env.remote.receive).toHaveBeenCalledTimes(1);
      const outputs = env.remote.receive.mock.calls[0]![0].outputData.keep;
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.every((output) => output.blindedMessage.id === newKeyset)).toBe(true);
    });
  }

  it('preserves a legacy init child and its attempt through a transient restart failure', async () => {
    const { env, repos, parent } = await createParent();
    const request = await parent.create({ amount: 7, requestId: 'request', mints: [receiveMint] });
    const draft = await env.service.init(receiveToken(), {
      type: 'payment-request',
      requestOperationId: request.id,
      requestId: request.requestId,
      attemptId: 'legacy',
      transport: 'inband',
    });
    await repos.receiveOperationRepository.create(draft);
    await repos.paymentRequestReceiveAttemptRepository.create({
      id: 'legacy',
      requestOperationId: request.id,
      requestId: request.requestId,
      transport: 'inband',
      payloadHash: 'legacy',
      mintUrl: receiveMint,
      unit: 'sat',
      grossAmount: Amount.from(7),
      state: 'validating',
      createdAt: 1,
      updatedAt: 1,
    });
    env.loadSeed.mockRejectedValueOnce(new Error('Seed temporarily unavailable'));
    await parent.recoverPendingAttempts();
    expect(await repos.receiveOperationRepository.getById(draft.id)).toMatchObject({
      state: 'init',
    });
    expect(await repos.paymentRequestReceiveAttemptRepository.getById('legacy')).toMatchObject({
      state: 'validating',
    });
    expect(env.remote.receive).not.toHaveBeenCalled();
    await parent.recoverPendingAttempts();
    expect(await repos.paymentRequestReceiveAttemptRepository.getById('legacy')).toMatchObject({
      state: 'finalized',
      receiveOperationId: draft.id,
    });
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
  });
});
