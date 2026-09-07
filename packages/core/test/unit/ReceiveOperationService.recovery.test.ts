import { type ProofState } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ReceiveOpsApi } from '../../api/ReceiveOpsApi.ts';
import { MintOperationError, ProofValidationError } from '../../models/Error.ts';
import type { ExecutingReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import { mapProofToCoreProof } from '../../utils.ts';
import {
  createReceiveEnvironment,
  receiveInput,
  receiveMintUrl,
} from '../fixtures/ReceiveEnvironment.ts';
import { receivedProofs } from '../fixtures/ReceiveRemote.ts';

const mintUrl = receiveMintUrl;
const token = () => ({ mint: mintUrl, unit: 'sat', proofs: [receiveInput()] });
const proofState = (state: 'SPENT' | 'UNSPENT' | 'PENDING'): ProofState => ({
  Y: 'test',
  witness: null,
  state,
});

describe('ReceiveOperationService recovery', () => {
  let env: Awaited<ReturnType<typeof createReceiveEnvironment>>;
  beforeEach(async () => {
    env = await createReceiveEnvironment();
  });
  const executing = async (): Promise<ExecutingReceiveOperation> => {
    const prepared = await env.service.prepare(await env.service.init(token()));
    return (await env.transactions.beginExecution({ operationId: prepared.id, updatedAt: 300 }))
      .operation;
  };
  const storedState = async (id: string) =>
    (await env.repositories.receiveOperationRepository.getById(id))?.state;

  it('cleans up legacy init records without mint contact or allocating outputs', async () => {
    const init = await env.service.init(token());
    await env.repositories.receiveOperationRepository.create(init);
    await env.service.recoverPendingOperations();
    expect(await env.repositories.receiveOperationRepository.getById(init.id)).toBeNull();
    expect(env.remote.receive).not.toHaveBeenCalled();
    expect(env.loadSeed).not.toHaveBeenCalled();
  });

  it('leaves prepared operations untouched for an explicit execute or cancel', async () => {
    const prepared = await env.service.prepare(await env.service.init(token()));
    await env.service.recoverPendingOperations();
    expect(await storedState(prepared.id)).toBe('prepared');
    expect(env.remote.receive).not.toHaveBeenCalled();
  });

  it('restarts with the exact persisted inputs and output allocation', async () => {
    const operation = await executing();
    const restarted = env.buildService({
      loadSeed: async () => {
        throw new Error('Recovery must not load seed');
      },
      signer: {
        signProof: async () => {
          throw new Error('Recovery must not sign');
        },
      },
    });
    env.remote.receive.mockImplementationOnce(async (request) => {
      expect(env.repositories.transactionOpen).toBe(false);
      expect(request.inputProofs).toEqual(operation.inputProofs);
      expect(request.outputData).toEqual(operation.outputData);
      return receivedProofs(request.outputData);
    });
    await restarted.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('finalized');
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
    await restarted.recoverPendingOperations();
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent recovery from independent coordinators without duplicate output proofs', async () => {
    const operation = await executing();
    await Promise.all([
      env.service.recoverPendingOperations(),
      env.buildService().recoverPendingOperations(),
    ]);
    expect(await storedState(operation.id)).toBe('finalized');
    expect(
      await env.repositories.proofRepository.getProofsByOperationId(mintUrl, operation.id),
    ).toHaveLength(operation.outputData.keep.length);
  });

  it.each(['complete-unspent', 'complete-spent'] as const)(
    'finalizes exact Restore evidence: %s',
    async (status) => {
      const operation = await executing();
      const proofs = receivedProofs(operation.outputData);
      env.remote.checkProofStates.mockResolvedValueOnce([proofState('SPENT')]);
      env.remote.observeRestore.mockImplementationOnce(async (outputs) => {
        expect(env.repositories.transactionOpen).toBe(false);
        expect(outputs).toEqual(operation.outputData);
        return {
          status,
          expectedOutputCount: proofs.length,
          restoredProofs: proofs,
          unspentProofs: status === 'complete-unspent' ? proofs : [],
        };
      });
      await env.service.recoverPendingOperations();
      expect(await storedState(operation.id)).toBe('finalized');
      const saved = await env.repositories.proofRepository.getProofsByOperationId(
        mintUrl,
        operation.id,
      );
      expect(saved.map((proof) => proof.state)).toEqual(
        proofs.map(() => (status === 'complete-unspent' ? 'ready' : 'spent')),
      );
      expect(env.remote.receive).not.toHaveBeenCalled();
    },
  );

  it('fails spent inputs only after a successful Restore finding no exact outputs', async () => {
    const operation = await executing();
    env.remote.checkProofStates.mockResolvedValueOnce([proofState('SPENT')]);
    await env.service.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('rolled_back');
    expect(env.remote.observeRestore).toHaveBeenCalledTimes(1);
  });

  it('retains executing when the mint cannot provide input-state evidence', async () => {
    const operation = await executing();
    env.remote.checkProofStates.mockRejectedValueOnce(new Error('offline'));
    await env.service.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('executing');
    expect(env.remote.observeRestore).not.toHaveBeenCalled();
  });

  it.each([{ states: [] }, { states: [proofState('PENDING')] }])(
    'retains executing for incomplete or pending inputs ($states)',
    async ({ states }) => {
      const operation = await executing();
      env.remote.checkProofStates.mockResolvedValueOnce([...states]);
      await env.service.recoverPendingOperations();
      expect(await storedState(operation.id)).toBe('executing');
      expect(env.remote.receive).not.toHaveBeenCalled();
      expect(env.remote.observeRestore).not.toHaveBeenCalled();
    },
  );

  it('retains executing when inputs have mixed spent states', async () => {
    const prepared = await env.service.prepare(
      await env.service.init({ ...token(), proofs: [receiveInput('a'), receiveInput('b')] }),
    );
    await env.transactions.beginExecution({ operationId: prepared.id, updatedAt: 300 });
    env.remote.checkProofStates.mockResolvedValueOnce([proofState('SPENT'), proofState('UNSPENT')]);
    await env.service.recoverPendingOperations();
    expect(await storedState(prepared.id)).toBe('executing');
    expect(env.remote.receive).not.toHaveBeenCalled();
  });

  it.each([
    new Error('restore unavailable'),
    new ProofValidationError('invalid Restore signature'),
  ])('retains executing on Restore failure: %s', async (error) => {
    const operation = await executing();
    env.remote.checkProofStates.mockResolvedValueOnce([proofState('SPENT')]);
    env.remote.observeRestore.mockRejectedValueOnce(error);
    await env.service.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('executing');
  });

  it('retains executing for incomplete or mixed Restore evidence', async () => {
    const operation = await executing();
    env.remote.checkProofStates.mockResolvedValueOnce([proofState('SPENT')]);
    env.remote.observeRestore.mockResolvedValueOnce({
      status: 'inconclusive',
      expectedOutputCount: 1,
      restoredProofs: receivedProofs(operation.outputData),
      unspentProofs: [],
    });
    await env.service.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('executing');
    expect(
      await env.repositories.proofRepository.getProofsByOperationId(mintUrl, operation.id),
    ).toEqual([]);
  });

  it.each([11001, 12001, 0])(
    'records replay rejection %s only after Restore establishes no result',
    async (code) => {
      const operation = await executing();
      env.remote.receive.mockRejectedValueOnce(new MintOperationError(code, 'terminal rejection'));
      await env.service.recoverPendingOperations();
      expect(await storedState(operation.id)).toBe('rolled_back');
      expect(env.remote.observeRestore).toHaveBeenCalledTimes(1);
    },
  );

  it.each([11002, 11003, 11004])(
    'retains executing after recovery-sensitive replay rejection %s',
    async (code) => {
      const operation = await executing();
      env.remote.receive.mockRejectedValueOnce(new MintOperationError(code, 'ambiguous'));
      await env.service.recoverPendingOperations();
      expect(await storedState(operation.id)).toBe('executing');
    },
  );

  it('uses Restore to establish success after another submission consumed the inputs during replay', async () => {
    const operation = await executing();
    const proofs = receivedProofs(operation.outputData);
    env.remote.receive.mockRejectedValueOnce(new MintOperationError(11001, 'already spent'));
    env.remote.observeRestore.mockResolvedValueOnce({
      status: 'complete-unspent',
      expectedOutputCount: proofs.length,
      restoredProofs: proofs,
      unspentProofs: proofs,
    });
    await env.service.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('finalized');
  });

  it('retains executing if Restore is unavailable after a definitive replay rejection', async () => {
    const operation = await executing();
    env.remote.receive.mockRejectedValueOnce(new MintOperationError(11001, 'already spent'));
    env.remote.observeRestore.mockRejectedValueOnce(new Error('offline'));
    await env.service.recoverPendingOperations();
    expect(await storedState(operation.id)).toBe('executing');
  });

  it('uses already saved exact outputs before querying the mint', async () => {
    const operation = await executing();
    await env.repositories.proofRepository.saveProofs(
      mintUrl,
      mapProofToCoreProof(mintUrl, 'spent', receivedProofs(operation.outputData), {
        unit: operation.unit,
        createdByOperationId: operation.id,
      }),
    );
    await new ReceiveOpsApi(env.buildService()).refresh(operation.id);
    expect(await storedState(operation.id)).toBe('finalized');
    expect(env.remote.checkProofStates).not.toHaveBeenCalled();
    expect(env.remote.receive).not.toHaveBeenCalled();
  });
});
