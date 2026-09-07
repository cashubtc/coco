import { Amount, type Proof, type Token } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  MintOperationError,
  NetworkError,
  ProofValidationError,
  UnknownMintError,
  TokenValidationError,
} from '../../models/Error.ts';
import type {
  PreparedReceiveOperation,
  ReceiveOperation,
} from '../../operations/receive/ReceiveOperation.ts';
import { HistoryService } from '../../services/HistoryService.ts';
import { mapProofToCoreProof } from '../../utils.ts';
import {
  createReceiveEnvironment,
  receiveInput,
  receiveKeysetId,
  receiveMintUrl,
} from '../fixtures/ReceiveEnvironment.ts';
import { receivedProofs } from '../fixtures/ReceiveRemote.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';
import { testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = receiveMintUrl;
const token = (proofs = [receiveInput()]): Token => ({ mint: mintUrl, proofs, unit: 'sat' });

describe('ReceiveOperationService', () => {
  let env: Awaited<ReturnType<typeof createReceiveEnvironment>>;
  beforeEach(async () => {
    env = await createReceiveEnvironment();
  });
  const prepare = async () => env.service.prepare(await env.service.init(token()));

  it('receives into one finalized operation and emits its committed result', async () => {
    let finalizedId: string | undefined;
    env.eventBus.on('receive-op:finalized', async ({ operationId }) => {
      expect(env.repositories.transactionOpen).toBe(false);
      expect((await env.repositories.receiveOperationRepository.getById(operationId))?.state).toBe(
        'finalized',
      );
      expect(
        await env.repositories.proofRepository.getProofsByOperationId(mintUrl, operationId),
      ).toHaveLength(1);
      finalizedId = operationId;
    });
    await env.service.receive(token([receiveInput('a'), receiveInput('b')]));
    const finalized = await env.repositories.receiveOperationRepository.getByState('finalized');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.id).toBe(finalizedId!);
    expect(finalized[0]!.amount.equals(Amount.from(20))).toBe(true);
    expect(env.repositories.transactionCount).toBe(3);
  });

  it('keeps init transient and persists preparation with Payment Request metadata', async () => {
    const source = {
      type: 'payment-request' as const,
      requestOperationId: 'parent',
      attemptId: 'attempt',
      transport: 'nostr' as const,
      memo: 'memo',
    };
    const init = await env.service.init(token(), source);
    expect(await env.repositories.receiveOperationRepository.getById(init.id)).toBeNull();
    const prepared = await env.service.prepare(init);
    expect(prepared).toMatchObject({ state: 'prepared', revision: 0, source });
    expect(prepared.fee.isZero()).toBe(true);
    expect(
      (await env.repositories.counterRepository.getCounter(mintUrl, receiveKeysetId))?.counter,
    ).toBe(1);
  });

  it('signs P2PK during preflight and submits the persisted witness after the key is removed', async () => {
    const publicKey = testMintKeypairs['1'];
    await env.repositories.keyRingRepository.setPersistedKeyPair({
      publicKeyHex: publicKey,
      secretKey: new Uint8Array(32).fill(1),
      purpose: 'p2pk',
    });
    const proof = receiveInput(
      JSON.stringify(['P2PK', { nonce: 'test', data: publicKey, tags: [] }]),
    );
    const init = await env.service.init(token([proof]));
    expect(init.inputProofs[0]!.witness).toContain('signatures');
    const prepared = await env.service.prepare(init);
    await env.repositories.keyRingRepository.deletePersistedKeyPair(publicKey, 'p2pk');
    env.remote.receive.mockImplementationOnce(async (request) => {
      expect(env.repositories.transactionOpen).toBe(false);
      expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
        'executing',
      );
      expect(request.inputProofs).toEqual(prepared.inputProofs);
      expect(request.outputData).toEqual(prepared.outputData);
      return receivedProofs(request.outputData);
    });
    await env.service.execute({ ...prepared, inputProofs: [receiveInput('stale-copy')] });
    expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
      'finalized',
    );
  });

  it('allocates different outputs across independent coordinators', async () => {
    const other = env.buildService();
    const first = await env.service.init(token([receiveInput('a')]));
    const second = await other.init(token([receiveInput('b')]));
    const results = await Promise.all([env.service.prepare(first), other.prepare(second)]);
    expect(results[0]!.outputData.keep[0]!.secret).not.toBe(results[1]!.outputData.keep[0]!.secret);
    expect(
      (await env.repositories.counterRepository.getCounter(mintUrl, receiveKeysetId))?.counter,
    ).toBe(2);
  });

  it('publishes prepared and cancelled events after commit and releasing its operation lock', async () => {
    const states: string[] = [];
    for (const event of ['receive-op:prepared', 'receive-op:rolled-back'] as const) {
      env.eventBus.on(event, async ({ operationId, operation }) => {
        expect(env.repositories.transactionOpen).toBe(false);
        expect(env.service.isOperationLocked(operationId)).toBe(false);
        states.push(
          (await env.repositories.receiveOperationRepository.getById(operationId))!.state,
        );
        expect(states.at(-1)).toBe(operation.state);
      });
    }
    const prepared = await prepare();
    await env.service.rollback(prepared.id);
    expect(states).toEqual(['prepared', 'rolled_back']);
  });

  it('preserves executing request after a failure before local result application', async () => {
    const prepared = await prepare();
    const applyResult = env.transactions.applyResult.bind(env.transactions);
    env.transactions.applyResult = async () => {
      throw new Error('simulated crash before apply');
    };
    await expect(env.service.execute(prepared)).rejects.toThrow('simulated crash before apply');
    const stored = await env.repositories.receiveOperationRepository.getById(prepared.id);
    expect(stored).toMatchObject({
      state: 'executing',
      inputProofs: prepared.inputProofs,
      outputData: prepared.outputData,
    });
    expect(
      await env.repositories.proofRepository.getProofsByOperationId(mintUrl, prepared.id),
    ).toEqual([]);
    env.transactions.applyResult = applyResult;
    await env.service.recoverPendingOperations();
    expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
      'finalized',
    );
  });

  it('logs event listener failures without failing committed value movement', async () => {
    const error = mock(() => {});
    const service = env.buildService({
      logger: { error, warn: mock(() => {}), debug: mock(() => {}), info: mock(() => {}) },
    });
    env.eventBus.on('receive-op:finalized', () => {
      throw new Error('listener failed');
    });
    const prepared = await prepare();
    await expect(service.execute(prepared)).resolves.toMatchObject({ state: 'finalized' });
    expect(error).toHaveBeenCalled();
    expect(env.remote.receive).toHaveBeenCalledTimes(1);
  });

  it('projects cancelled Receive history', async () => {
    const history = env.repositories.historyRepository;
    new HistoryService(history, env.eventBus);
    const prepared = await prepare();
    await env.service.rollback(prepared.id);
    expect((await history.getPaginatedHistoryEntries(10, 0))[0]?.state).toBe('rolled_back');
  });

  it('rejects untrusted mints before remote or signing work', async () => {
    await env.repositories.mintRepository.setMintTrusted(mintUrl, false);
    await expect(env.service.init(token())).rejects.toThrow(UnknownMintError);
    expect(env.remote.open).not.toHaveBeenCalled();
    expect(env.remote.fetchMintMetadata).not.toHaveBeenCalled();
  });

  it('rechecks trust after init before committing preparation', async () => {
    const init = await env.service.init(token());
    await env.repositories.mintRepository.setMintTrusted(mintUrl, false);
    await expect(env.service.prepare(init)).rejects.toThrow(UnknownMintError);
    expect(
      await env.repositories.counterRepository.getCounter(mintUrl, receiveKeysetId),
    ).toBeNull();
    expect(await env.repositories.receiveOperationRepository.getById(init.id)).toBeNull();
  });

  it('calculates authoritative fees after asynchronous preflight', async () => {
    const init = await env.service.init(token());
    env.loadSeed.mockImplementationOnce(async () => {
      expect(env.repositories.transactionOpen).toBe(false);
      await env.repositories.keysetRepository.updateKeyset({
        mintUrl,
        id: receiveKeysetId,
        unit: 'sat',
        active: true,
        feePpk: 1000,
      });
      return new Uint8Array(64).fill(1);
    });
    const prepared = await env.service.prepare(init);
    expect(prepared.fee.equals(Amount.from(1))).toBe(true);
    expect(prepared.outputData.keep[0]!.blindedMessage.amount).toBe('9');
  });

  it('validates token syntax, proof count, amount, and unit', async () => {
    await expect(env.service.init('not-a-token')).rejects.toThrow(ProofValidationError);
    await expect(env.service.init(token([]))).rejects.toThrow(ProofValidationError);
    await expect(env.service.init(token([receiveInput('zero', 0)]))).rejects.toThrow(
      ProofValidationError,
    );
    await expect(env.service.init({ ...token(), unit: 'usd' })).rejects.toThrow(
      ProofValidationError,
    );
  });

  it('preserves the token validation error type when init cannot load metadata', async () => {
    const service = env.buildService({
      mintQueries: {
        ...env.dependencies.mintQueries,
        isTrustedMint: async () => true,
        getMetadata: async () => {
          throw new Error('storage unavailable');
        },
      },
    });
    await expect(service.init(token())).rejects.toThrow(TokenValidationError);
  });

  it('accepts matching non-sat keysets and units', async () => {
    const keysetId = testMintKeysetId('usd');
    await env.repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'usd',
      active: true,
      feePpk: 0,
      keypairs: testMintKeypairs,
    });
    const init = await env.service.init({
      mint: mintUrl,
      unit: 'USD',
      proofs: [{ ...receiveInput(), id: keysetId }],
    });
    const prepared = await env.service.prepare(init);
    expect(prepared.unit).toBe('usd');
    expect(prepared.outputData.keep[0]!.blindedMessage.id).toBe(keysetId);
    await expect(env.service.execute(prepared)).resolves.toMatchObject({
      state: 'finalized',
      unit: 'usd',
    });
  });

  it.each([10_000, 11_000])(
    'rejects fees consuming the incoming amount (%s ppk)',
    async (feePpk) => {
      const init = await env.service.init(token());
      await env.repositories.keysetRepository.updateKeyset({
        mintUrl,
        id: receiveKeysetId,
        unit: 'sat',
        active: true,
        feePpk,
      });
      await expect(env.service.prepare(init)).rejects.toThrow(
        'Receive amount is not sufficient after fees',
      );
      expect(
        await env.repositories.counterRepository.getCounter(mintUrl, receiveKeysetId),
      ).toBeNull();
    },
  );

  it('rejects empty inputs and empty deterministic outputs without persisting preparation', async () => {
    const init = await env.service.init(token());
    await expect(env.service.prepare({ ...init, inputProofs: [] })).rejects.toThrow(
      ProofValidationError,
    );
    const empty = await createReceiveEnvironment(
      undefined,
      makeOutputDataCreator({ createDeterministicData: () => [] }),
    );
    const intent = await empty.service.init(token());
    await expect(empty.service.prepare(intent)).rejects.toThrow(
      'Failed to create deterministic outputs',
    );
    expect(await empty.repositories.receiveOperationRepository.getById(intent.id)).toBeNull();
  });

  it('refreshes metadata explicitly and emits only after the cache commit', async () => {
    const mint = await env.repositories.mintRepository.getMintByUrl(mintUrl);
    await env.repositories.mintRepository.updateMint({ ...mint, updatedAt: 1 });
    env.remote.fetchMintMetadata.mockImplementationOnce(async () => {
      expect(env.repositories.transactionOpen).toBe(false);
      return {
        mintUrl,
        mintInfo: mint.mintInfo,
        keysets: [
          {
            mintUrl,
            id: receiveKeysetId,
            unit: 'sat',
            active: true,
            feePpk: 1000,
            keypairs: testMintKeypairs,
          },
        ],
        observedAt: Math.floor(Date.now() / 1000),
      };
    });
    const fees: number[] = [];
    env.eventBus.on('mint:metadata-refreshed', async () => {
      expect(env.repositories.transactionOpen).toBe(false);
      fees.push(
        (await env.repositories.keysetRepository.getKeysetById(mintUrl, receiveKeysetId))!.feePpk,
      );
    });
    const prepared = await prepare();
    expect(fees).toEqual([1000]);
    expect(prepared.fee.equals(Amount.from(1))).toBe(true);
    expect(env.remote.fetchMintMetadata).toHaveBeenCalledTimes(1);
  });

  it('rejects a persisted operation with missing output data before mint contact', async () => {
    const prepared = await prepare();
    await env.repositories.receiveOperationRepository.update({
      ...prepared,
      outputData: undefined,
    } as unknown as ReceiveOperation);
    await expect(env.service.execute(prepared)).rejects.toThrow('Missing output data');
    expect(env.remote.receive).not.toHaveBeenCalled();
  });

  it.each([11001, 12001, 0])(
    'records definitive mint rejection %s atomically and projects history',
    async (code) => {
      const history = env.repositories.historyRepository;
      new HistoryService(history, env.eventBus);
      const prepared = await prepare();
      env.remote.receive.mockRejectedValueOnce(new MintOperationError(code, 'mint rejection'));
      await expect(env.service.execute(prepared)).rejects.toThrow('mint rejection');
      expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
        'rolled_back',
      );
      expect(
        await env.repositories.proofRepository.getProofsByOperationId(mintUrl, prepared.id),
      ).toEqual([]);
      expect((await history.getPaginatedHistoryEntries(10, 0))[0]?.state).toBe('rolled_back');
    },
  );

  it.each([11002, 11003, 11004])('retains executing on ambiguous mint state %s', async (code) => {
    const prepared = await prepare();
    env.remote.receive.mockRejectedValueOnce(new MintOperationError(code, 'pending outcome'));
    await expect(env.service.execute(prepared)).rejects.toThrow('pending outcome');
    expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
      'executing',
    );
  });

  it.each([new NetworkError('timeout'), new ProofValidationError('invalid signature')])(
    'retains executing on %s',
    async (error) => {
      const prepared = await prepare();
      env.remote.receive.mockRejectedValueOnce(error);
      await expect(env.service.execute(prepared)).rejects.toThrow(error.message);
      expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
        'executing',
      );
    },
  );

  it('finalizes already saved outputs idempotently through the real result transaction', async () => {
    const prepared = await prepare();
    const begun = await env.transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
    });
    const proofs = mapProofToCoreProof(mintUrl, 'ready', receivedProofs(prepared.outputData), {
      unit: 'sat',
      createdByOperationId: prepared.id,
    });
    await env.repositories.proofRepository.saveProofs(mintUrl, proofs);
    await env.service.finalize(begun.operation.id);
    await env.service.finalize(begun.operation.id);
    expect((await env.repositories.receiveOperationRepository.getById(prepared.id))?.state).toBe(
      'finalized',
    );
    expect(env.remote.receive).not.toHaveBeenCalled();
  });

  it('does not finalize a prepared operation or executing operation without saved outputs', async () => {
    const prepared = await prepare();
    await expect(env.service.finalize(prepared.id)).rejects.toThrow('Cannot finalize operation');
    await env.transactions.beginExecution({ operationId: prepared.id, updatedAt: 300 });
    await expect(env.service.finalize(prepared.id)).rejects.toThrow('outputs not persisted');
  });
});
