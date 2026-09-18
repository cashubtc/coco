import type { PaymentRequestReceiveAttempt } from '../../operations/paymentRequestReceive/PaymentRequestReceiveOperation.ts';
import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { PaymentRequestReceiveService } from '../../services/PaymentRequestReceiveService.ts';
import { PaymentRequestReceiveTransportHandlerProvider } from '../../infra/handlers/paymentRequestReceive/index.ts';
import type { PaymentRequestReceiveAttemptRepository } from '../../repositories/index.ts';
import {
  createReceiveEnvironment,
  receiveMint,
  receiveToken,
  receivedCoreProofs,
} from '../fixtures/ReceiveEnvironment.ts';
import { createMintServiceForMetadata } from '../fixtures/MintMetadataRefresh.ts';

// Use the real child gateway so an in-memory init draft cannot masquerade as a persisted child.
describe('Payment Request Receive child persistence', () => {
  it.each(['claim', 'recovery'])(
    'resumes one durable prepared child after a failed %s link',
    async (path) => {
      const env = await createReceiveEnvironment();
      const repositories = env.repositories;
      const attempts = repositories.paymentRequestReceiveAttemptRepository;
      let failLinks = true;
      let receivedCheckpoint: PaymentRequestReceiveAttempt | undefined;
      const faultyAttempts: PaymentRequestReceiveAttemptRepository = {
        create: (attempt) => {
          receivedCheckpoint = attempt;
          return attempts.create(attempt);
        },
        update: async (attempt) => {
          if (failLinks && attempt.state === 'receiving') throw new Error('Child link failed');
          return attempts.update(attempt);
        },
        getById: (id) => attempts.getById(id),
        getByRequestOperationId: (id) => attempts.getByRequestOperationId(id),
        getByState: (state) => attempts.getByState(state),
        getByRequestIdAndPayloadHash: (id, hash) => attempts.getByRequestIdAndPayloadHash(id, hash),
        getByPayloadHash: (id, hash) => attempts.getByPayloadHash(id, hash),
        getByTransportMessageId: (id) => attempts.getByTransportMessageId(id),
        getByReceiveOperationId: (id) => attempts.getByReceiveOperationId(id),
        delete: (id) => attempts.delete(id),
      };
      const makeParent = (attemptRepository = attempts) =>
        new PaymentRequestReceiveService(
          repositories.paymentRequestReceiveOperationRepository,
          attemptRepository,
          env.buildService(),
          repositories.receiveOperationRepository,
          createMintServiceForMetadata(repositories),
          new PaymentRequestReceiveTransportHandlerProvider(),
        );
      const parent = makeParent(faultyAttempts);
      const operation = await parent.create({
        amount: { amount: Amount.from(7), unit: 'sat' },
        mints: [receiveMint],
        requestId: 'request',
        singleUse: true,
      });
      const payload = { ...receiveToken(), id: 'request', unit: 'sat' };
      if (path === 'recovery') {
        env.loadSeed.mockRejectedValueOnce(new Error('Seed temporarily unavailable'));
        await expect(parent.claimPayload(operation.id, payload)).rejects.toThrow();
        // Restart from the persisted payload checkpoint, before child preparation began.
        if (!receivedCheckpoint) throw new Error('Expected persisted payload');
        await attempts.delete(receivedCheckpoint.id);
        await attempts.create({ ...receivedCheckpoint, state: 'validating' });
        await parent.recoverPendingAttempts();
      } else {
        await expect(parent.claimPayload(operation.id, payload)).rejects.toThrow(
          'Child link failed',
        );
      }
      const [attempt] = await attempts.getByRequestOperationId(operation.id);
      expect(attempt?.state).toBe('validating');
      const child = await repositories.receiveOperationRepository.getByPaymentRequestAttemptId(
        attempt!.id,
      );
      expect(child?.state).toBe('prepared');
      expect(env.remote.receive).not.toHaveBeenCalled();
      failLinks = false;
      await makeParent().recoverPendingAttempts();
      const recovered = (await attempts.getById(attempt!.id))!;
      expect(recovered.state).toBe('finalized');
      expect(recovered.receiveOperationId).toBe(child!.id);
      const finalized = (await env.service.getOperation(child!.id))!;
      expect(finalized.state).toBe('finalized');
      if (finalized.state !== 'finalized' || child?.state !== 'prepared')
        throw new Error('Expected completed Receive');
      expect(finalized.outputData).toEqual(child.outputData);
      expect((await repositories.proofRepository.getAvailableProofs(receiveMint)).length).toBe(
        receivedCoreProofs(finalized).length,
      );
      expect(env.remote.receive).toHaveBeenCalledTimes(1);
    },
  );
});
