import { describe, expect, it, mock } from 'bun:test';
import { MintOperationError, ReceiveOperationConflictError } from '../../models/Error.ts';
import type { ExecutingReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import {
  createReceiveEnvironment,
  ReceiveTestRepositories,
  receiveMint,
  receiveKeys,
  proofStates,
  issuedProofs,
  receivedCoreProofs,
} from '../fixtures/ReceiveEnvironment.ts';

async function executingEnvironment() {
  const repos = new ReceiveTestRepositories();
  const env = await createReceiveEnvironment(repos);
  const prepared = await env.prepare();
  const executing = await env.transactions.beginExecution({
    operationId: prepared.id,
    updatedAt: Date.now(),
  });
  return { ...env, repos, executing };
}

describe('Receive recovery', () => {
  it('replays exactly the saved request after restart without loading a seed', async () => {
    const env = await executingEnvironment();
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs));
    env.loadSeed.mockRejectedValue(new Error('Seed unavailable'));
    await env.buildService().recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('finalized');
    const request = env.remote.receive.mock.calls[0]![0];
    expect(request.inputProofs).toEqual(env.executing.inputProofs);
    expect(request.outputData).toEqual(env.executing.outputData);
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
  });

  it.each([11001, 11002, 11003, 11004, 99999])(
    'retains an ambiguous request after mint error %i',
    async (code) => {
      const env = await createReceiveEnvironment();
      const prepared = await env.prepare();
      env.remote.receive.mockRejectedValue(new MintOperationError(code, 'Rejected'));
      await expect(env.service.execute(prepared)).rejects.toBeInstanceOf(MintOperationError);
      const current = await env.service.getOperation(prepared.id);
      expect(current?.state).toBe('executing');
      expect((current as ExecutingReceiveOperation).outputData).toEqual(prepared.outputData);
    },
  );

  it('rolls back a conclusive first-submission validation rejection', async () => {
    const env = await createReceiveEnvironment();
    const prepared = await env.prepare();
    env.remote.receive.mockRejectedValue(new MintOperationError(11005, 'Not balanced'));
    await expect(env.service.execute(prepared)).rejects.toThrow('Not balanced');
    expect((await env.service.getOperation(prepared.id))?.state).toBe('rolled_back');
    expect(env.remote.checkProofStates).not.toHaveBeenCalled();
  });

  it('fences a late initial rejection after another session claims recovery', async () => {
    const env = await createReceiveEnvironment();
    const prepared = await env.prepare();
    const started = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<never>();
    env.remote.receive.mockImplementationOnce(() => {
      started.resolve();
      return rejected.promise;
    });
    const execution = env.service.execute(prepared);
    await started.promise;
    const current = (await env.service.getOperation(prepared.id)) as ExecutingReceiveOperation;
    const claim = await env.transactions.claimRecovery({
      operationId: current.id,
      expectedRevision: current.revision!,
      updatedAt: Date.now(),
    });
    rejected.reject(new MintOperationError(11005, 'Late rejection'));
    await expect(execution).rejects.toThrow('Late rejection');
    expect((await env.service.getOperation(prepared.id))?.state).toBe('executing');
    await expect(
      env.transactions.failExecution({
        operationId: prepared.id,
        expectedRevision: current.revision!,
        updatedAt: Date.now(),
        error: 'Late rejection',
      }),
    ).rejects.toBeInstanceOf(ReceiveOperationConflictError);
    // A valid result from either submitter still settles the immutable request.
    await env.transactions.applyResult({
      operationId: prepared.id,
      proofs: receivedCoreProofs(claim),
      updatedAt: Date.now(),
    });
    expect((await env.service.getOperation(prepared.id))?.state).toBe('finalized');
  });

  it('returns the recovered success when the initial response is lost', async () => {
    const env = await createReceiveEnvironment();
    const prepared = await env.prepare();
    env.remote.receive.mockRejectedValue(new Error('Response lost'));
    env.remote.checkProofStates.mockImplementation(async (proofs) =>
      proofStates(
        proofs,
        proofs[0]?.secret === prepared.inputProofs[0]?.secret ? 'SPENT' : 'UNSPENT',
      ),
    );
    env.remote.restoreOutputs.mockImplementation(async (data) => issuedProofs(data));
    const finalized = await env.service.execute(prepared);
    expect(finalized.state).toBe('finalized');
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
    expect(receivedCoreProofs(finalized).map((p) => p.secret)).toEqual(
      receivedCoreProofs(prepared).map((p) => p.secret),
    );
  });

  it('reobserves a replay rejection and restores the original successful request', async () => {
    const env = await executingEnvironment();
    env.remote.checkProofStates.mockImplementation(async (proofs) =>
      proofStates(
        proofs,
        proofs[0]?.secret === env.executing.inputProofs[0]?.secret ? 'SPENT' : 'UNSPENT',
      ),
    );
    env.remote.checkProofStates.mockImplementationOnce(async (proofs) => proofStates(proofs));
    env.remote.receive.mockRejectedValue(new MintOperationError(11001, 'Spent by other executor'));
    env.remote.restoreOutputs.mockImplementation(async (data) => issuedProofs(data));
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('finalized');
  });

  it('keeps a replay validation rejection ambiguous when no spent evidence exists', async () => {
    const env = await executingEnvironment();
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs));
    env.remote.receive.mockRejectedValue(new MintOperationError(12002, 'Keyset rotated'));
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('executing');
    expect(env.remote.restoreOutputs).not.toHaveBeenCalled();
  });

  it.each(['empty', 'wrong-Y', 'pending'])(
    'retains recovery material for %s input-state evidence',
    async (kind) => {
      const env = await executingEnvironment();
      env.remote.checkProofStates.mockImplementation(async (proofs) => {
        if (kind === 'empty') return [];
        const states = proofStates(proofs, kind === 'pending' ? 'PENDING' : 'SPENT');
        if (kind === 'wrong-Y') states[0]!.Y = 'wrong';
        return states;
      });
      await env.service.recoverExecutingOperation(env.executing);
      expect((await env.service.getOperation(env.executing.id))?.state).toBe('executing');
      expect(env.remote.receive).not.toHaveBeenCalled();
      expect(env.remote.restoreOutputs).not.toHaveBeenCalled();
    },
  );

  it('finalizes mixed spent and unspent restored outputs without crediting spent value', async () => {
    const env = await executingEnvironment();
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs, 'SPENT'));
    env.remote.restoreOutputs.mockImplementation(async (data) => issuedProofs(data));
    env.remote.checkProofStates.mockImplementationOnce(async (proofs) =>
      proofStates(proofs, 'SPENT'),
    );
    env.remote.checkProofStates.mockImplementationOnce(async (proofs) =>
      proofStates(proofs).map((state, i) => ({
        ...state,
        state: (i === 0 ? 'SPENT' : 'UNSPENT') as typeof state.state,
      })),
    );
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('finalized');
    const proofs = await env.repositories.proofRepository.getProofsBySecrets(
      receiveMint,
      receivedCoreProofs(env.executing).map((proof) => proof.secret),
    );
    expect(proofs.filter((proof) => proof.state === 'spent')).toHaveLength(1);
    expect(proofs.filter((proof) => proof.state === 'ready')).toHaveLength(2);
  });

  it('finalizes a legacy partial save with later reservations and spending intact', async () => {
    const env = await executingEnvironment();
    const outputs = receivedCoreProofs(env.executing);
    await env.repositories.proofRepository.saveProofs(receiveMint, [
      { ...outputs[0]!, state: 'spent', usedByOperationId: 'later-send' },
    ]);
    env.remote.checkProofStates.mockImplementation(async (proofs) =>
      proofStates(
        proofs,
        proofs[0]?.secret === env.executing.inputProofs[0]?.secret ? 'SPENT' : 'UNSPENT',
      ),
    );
    env.remote.restoreOutputs.mockResolvedValue(issuedProofs(env.executing.outputData).slice(1));
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('finalized');
    const [existing] = await env.repositories.proofRepository.getProofsBySecrets(receiveMint, [
      outputs[0]!.secret,
    ]);
    expect(existing?.state).toBe('spent');
    expect(existing?.usedByOperationId).toBe('later-send');
  });

  it('preserves conflicting local outputs and keeps the Receive executing', async () => {
    const env = await executingEnvironment();
    const outputs = receivedCoreProofs(env.executing);
    await env.repositories.proofRepository.saveProofs(receiveMint, [
      { ...outputs[0]!, createdByOperationId: 'other' },
    ]);
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs, 'SPENT'));
    env.remote.restoreOutputs.mockImplementation(async (data) => issuedProofs(data));
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('executing');
    expect(
      (
        await env.repositories.proofRepository.getProofsBySecrets(receiveMint, [outputs[0]!.secret])
      )[0]?.createdByOperationId,
    ).toBe('other');
  });

  it('never rolls back when Restore is partial or unavailable', async () => {
    const env = await executingEnvironment();
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs, 'SPENT'));
    env.remote.restoreOutputs.mockResolvedValue(issuedProofs(env.executing.outputData).slice(0, 1));
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('executing');
    expect(await env.repositories.proofRepository.getAvailableProofs(receiveMint)).toEqual([]);
    env.remote.restoreOutputs.mockRejectedValue(new Error('Offline'));
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('executing');
  });

  it('rejects a duplicate receive only with complete spent inputs and no issued outputs', async () => {
    const env = await executingEnvironment();
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs, 'SPENT'));
    env.remote.restoreOutputs.mockResolvedValue([]);
    await env.service.recoverExecutingOperation(env.executing);
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('rolled_back');
    expect(await env.repositories.proofRepository.getAvailableProofs(receiveMint)).toEqual([]);
  });

  it('rolls back grouped proof writes on a local failure, then recovers once', async () => {
    const env = await executingEnvironment();
    const counter = await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys);
    const onFinalized = mock(() => {});
    env.eventBus.on('receive-op:finalized', onFinalized);
    env.repos.failNextCommit = true;
    await expect(
      env.transactions.applyResult({
        operationId: env.executing.id,
        updatedAt: Date.now(),
        proofs: receivedCoreProofs(env.executing),
      }),
    ).rejects.toThrow('Injected commit failure');
    expect((await env.service.getOperation(env.executing.id))?.state).toBe('executing');
    expect(await env.repositories.proofRepository.getAvailableProofs(receiveMint)).toEqual([]);
    env.remote.checkProofStates.mockImplementation(async (proofs) => proofStates(proofs));
    await env.service.recoverExecutingOperation(env.executing);
    await env.buildService().recoverExecutingOperation(env.executing);
    expect(onFinalized).toHaveBeenCalledTimes(1);
    expect(await env.repositories.counterRepository.getCounter(receiveMint, receiveKeys)).toEqual(
      counter,
    );
  });

  it('does not recreate outputs on repeated finalization after later spending and deletion', async () => {
    const env = await createReceiveEnvironment();
    const finalized = await env.service.execute(await env.prepare());
    const outputs = receivedCoreProofs(finalized);
    await env.repositories.proofRepository.deleteProofs(
      receiveMint,
      outputs.map((proof) => proof.secret),
    );
    await env.service.finalize(finalized.id);
    const replay = await env.transactions.applyResult({
      operationId: finalized.id,
      updatedAt: Date.now(),
      proofs: outputs,
    });
    expect(replay?.committed).toBe(false);
    expect(await env.repositories.proofRepository.getAvailableProofs(receiveMint)).toEqual([]);
  });
});
