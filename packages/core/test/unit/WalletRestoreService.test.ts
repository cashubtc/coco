import {
  Amount,
  deriveKeysetId,
  OutputData,
  Wallet,
  type OutputDataLike,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts';
import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import { WalletRestoreService } from '../../services/WalletRestoreService';
import type { ReceiveOperationService } from '../../operations/receive/ReceiveOperationService.ts';
import type { PreparedReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintRequestProvider } from '../../infra/MintRequestProvider';
import type { Logger } from '../../logging/Logger';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

describe('WalletRestoreService', () => {
  const originalWalletMethods = {
    loadMint: Wallet.prototype.loadMint,
    batchRestore: Wallet.prototype.batchRestore,
    checkProofsStates: Wallet.prototype.checkProofsStates,
    getFeesForProofs: Wallet.prototype.getFeesForProofs,
  };

  afterEach(() => {
    Object.assign(Wallet.prototype, originalWalletMethods);
  });

  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const bip39seed = new Uint8Array(64).fill(7);

  let receive: Pick<ReceiveOperationService, 'init' | 'prepare' | 'execute' | 'getOperation'>;
  let transactionRunner: RepositoryCoreTransactionRunner;
  let requestProvider: MintRequestProvider;
  let logger: Logger;
  let service: WalletRestoreService;

  const makeProof = (amount: number, secret: string): Proof =>
    ({
      amount: Amount.from(amount),
      C: `C_${secret}`,
      id: keysetId,
      secret,
    }) as unknown as Proof;

  beforeEach(() => {
    const prepared = {
      id: 'receive-1',
      state: 'prepared',
      amount: Amount.from(100),
      fee: Amount.from(1),
    } as PreparedReceiveOperation;
    receive = {
      init: mock(async () => ({ ...prepared, state: 'init' as const })),
      prepare: mock(async () => prepared),
      execute: mock(async () => ({ ...prepared, state: 'finalized' as const })),
      getOperation: mock(async () => ({ ...prepared, state: 'executing' as const })),
    };
    transactionRunner = new RepositoryCoreTransactionRunner(new MemoryRepositories());

    // Mock Logger
    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;

    // Mock MintRequestProvider
    requestProvider = {
      getRequestFn: mock(() => undefined),
    } as unknown as MintRequestProvider;

    // Prevent actual network calls when a new Wallet is created inside sweepKeyset
    // by stubbing loadMint on the Wallet prototype.
    (Wallet.prototype as any).loadMint = mock(() => Promise.resolve());

    service = new WalletRestoreService(receive, transactionRunner, requestProvider, logger);
  });

  describe('sweepKeyset', () => {
    it('uses the supplied creator for the sweep-specific Wallet Instance', async () => {
      const keypairs = {
        '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      };
      const sweepKeysetId = deriveKeysetId(keypairs, { unit: 'sat' });
      const output = {
        blindedMessage: {
          amount: Amount.zero(),
          id: sweepKeysetId,
          B_: 'custom-sweep-restore-output',
        },
        blindingFactor: 17n,
        secret: new Uint8Array([7, 8, 9]),
        toProof: mock(() => {
          throw new Error('not used when the mint returns no signatures');
        }),
      } satisfies OutputDataLike;
      const createDeterministicData = mock(() => [output]);
      const creator = makeOutputDataCreator({ createDeterministicData });

      Wallet.prototype.loadMint = mock(async function (this: Wallet) {
        this.loadMintFromCache(
          {
            name: 'Sweep Mint',
            version: '1.0.0',
            pubkey: 'test-pubkey',
            contact: [],
            nuts: {
              '4': { methods: [], disabled: false },
              '5': { methods: [], disabled: false },
            },
          } as any,
          {
            mintUrl,
            keysets: [
              {
                id: sweepKeysetId,
                unit: 'sat',
                active: true,
                input_fee_ppk: 0,
                keys: keypairs,
              },
            ],
          },
        );
      });
      const restoreRequest = mock(async () => ({ outputs: [], signatures: [] }));
      Wallet.prototype.batchRestore = mock(async function (this: Wallet, config) {
        this.mint.restore = restoreRequest;
        const restored = await this.restore(config?.counter ?? 0, 1, {
          keysetId: config?.keysetId,
        });
        return {
          proofs: restored.proofs,
          lastCounterWithSignature: restored.lastCounterWithSignature,
        };
      });
      service = new WalletRestoreService(
        receive,
        transactionRunner,
        requestProvider,
        logger,
        creator,
      );
      const originalCreateDeterministicData = OutputData.createDeterministicData;
      OutputData.createDeterministicData = () => {
        throw new Error('built-in deterministic creation must not be used');
      };

      try {
        await service.sweepKeyset(mintUrl, sweepKeysetId, bip39seed);
      } finally {
        OutputData.createDeterministicData = originalCreateDeterministicData;
      }

      expect(createDeterministicData).toHaveBeenCalledWith(
        0,
        bip39seed,
        0,
        expect.objectContaining({ id: sweepKeysetId }),
        [0],
      );
      expect(restoreRequest).toHaveBeenCalledWith({ outputs: [output.blindedMessage] });
    });

    it('reports pending source value without creating an exchange', async () => {
      Wallet.prototype.batchRestore = mock(async () => ({ proofs: [makeProof(8, 'pending')] }));
      Wallet.prototype.checkProofsStates = mock(async () => [{ state: 'PENDING' } as ProofState]);
      Wallet.prototype.getFeesForProofs = mock(() => Amount.zero());

      const result = await service.sweepKeyset(mintUrl, keysetId, bip39seed, 'USD');

      expect(result).toEqual({
        keysetId,
        unit: 'usd',
        status: 'skipped',
        reason: 'pending',
        pending: { count: 1, amount: Amount.from(8) },
      });
      expect(receive.prepare).not.toHaveBeenCalled();
    });

    it.each([null, [], [{ state: 'UNKNOWN' }], [null]].map((states) => [states]))(
      'reports malformed proof-state observations %j as failed',
      async (states) => {
        Wallet.prototype.batchRestore = mock(async () => ({ proofs: [makeProof(8, 'source')] }));
        Wallet.prototype.checkProofsStates = mock(async () => states as ProofState[]);
        expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed)).toMatchObject({
          keysetId,
          unit: 'sat',
          status: 'failed',
          error: new Error('Malformed state check'),
        });
        expect(receive.prepare).not.toHaveBeenCalled();
      },
    );

    it.each(['loadMint', 'batchRestore', 'checkProofsStates'] as const)(
      'reports a discovery failure in %s without pending observations',
      async (method) => {
        const error = new Error('discovery unavailable');
        Wallet.prototype.batchRestore = mock(async () => ({ proofs: [makeProof(8, 'source')] }));
        Wallet.prototype[method] = mock(async () => {
          throw error;
        });
        expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed)).toEqual({
          keysetId,
          unit: 'sat',
          status: 'failed',
          error,
        });
        expect(receive.init).not.toHaveBeenCalled();
      },
    );

    it('exchanges only available inputs and can sweep formerly pending value later', async () => {
      const available = makeProof(16, 'available');
      const pending = makeProof(8, 'pending');
      const spent = makeProof(4, 'spent');
      Wallet.prototype.batchRestore = mock(async () => ({ proofs: [available, pending, spent] }));
      let observations = ['UNSPENT', 'PENDING', 'SPENT'];
      Wallet.prototype.checkProofsStates = mock(async () =>
        observations.map((state) => ({ state }) as ProofState),
      );
      Wallet.prototype.getFeesForProofs = mock(() => Amount.from(1));
      const tokens: unknown[] = [];
      const init = receive.init;
      receive.init = async (token) => {
        tokens.push(token);
        return init(token);
      };

      expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed, 'USD')).toMatchObject({
        status: 'transferred',
        unit: 'usd',
        pending: { count: 1, amount: Amount.from(8) },
      });
      observations = ['SPENT', 'UNSPENT', 'SPENT'];
      expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed, 'USD')).toMatchObject({
        status: 'transferred',
        pending: { count: 0, amount: Amount.zero() },
      });
      expect(tokens).toEqual([
        { mint: mintUrl, proofs: [available], unit: 'usd' },
        { mint: mintUrl, proofs: [pending], unit: 'usd' },
      ]);
    });

    it.each([0, 1])('reports empty and fully spent discoveries as no-ops (%i)', async (count) => {
      Wallet.prototype.batchRestore = mock(async () => ({
        proofs: count ? [makeProof(8, 'spent')] : [],
      }));
      Wallet.prototype.checkProofsStates = mock(async () => [{ state: 'SPENT' } as ProofState]);
      expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed)).toMatchObject({
        status: 'noop',
      });
      expect(receive.prepare).not.toHaveBeenCalled();
    });

    it.each([8, 9])(
      'reports value that does not cover fees as an uneconomic skip (fee %i)',
      async (fee) => {
        Wallet.prototype.batchRestore = mock(async () => ({
          proofs: [makeProof(8, 'small'), makeProof(4, 'pending')],
        }));
        Wallet.prototype.checkProofsStates = mock(
          async () => [{ state: 'UNSPENT' }, { state: 'PENDING' }] as ProofState[],
        );
        Wallet.prototype.getFeesForProofs = mock(() => Amount.from(fee));
        expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed)).toMatchObject({
          status: 'skipped',
          reason: 'uneconomic',
          available: Amount.from(8),
          fee: Amount.from(fee),
          pending: { count: 1, amount: Amount.from(4) },
        });
        expect(receive.prepare).not.toHaveBeenCalled();
      },
    );

    it('preserves pending amounts beyond the safe integer range', async () => {
      const proof = { ...makeProof(1, 'large'), amount: Amount.from('9007199254740993') };
      Wallet.prototype.batchRestore = mock(async () => ({ proofs: [proof] }));
      Wallet.prototype.checkProofsStates = mock(async () => [{ state: 'PENDING' }] as ProofState[]);
      const result = await service.sweepKeyset(mintUrl, keysetId, bip39seed);
      expect(result.pending?.amount.toString()).toBe('9007199254740993');
    });

    it.each([
      'finalized',
      'rolled_back',
      'prepared',
      'executing',
      'missing',
      'unreadable',
    ] as const)('classifies rejected execution using public Receive state %s', async (state) => {
      Wallet.prototype.batchRestore = mock(async () => ({ proofs: [makeProof(100, 'available')] }));
      Wallet.prototype.checkProofsStates = mock(async () => [{ state: 'UNSPENT' }] as ProofState[]);
      Wallet.prototype.getFeesForProofs = mock(() => Amount.from(1));
      const prepared = await receive.prepare(await receive.init({ mint: mintUrl, proofs: [] }));
      receive.execute = mock(async () => {
        throw new Error('execution rejected');
      });
      receive.getOperation = async () => {
        if (state === 'unreadable') throw new Error('read unavailable');
        if (state === 'missing') return null;
        return { ...prepared, state };
      };
      const result = await service.sweepKeyset(mintUrl, keysetId, bip39seed);
      expect(result.status).toBe(
        state === 'finalized' ? 'transferred' : state === 'rolled_back' ? 'failed' : 'unresolved',
      );
      expect(result).toMatchObject({ receiveOperationId: prepared.id });
      if (result.status === 'transferred') expect(result.received).toEqual(Amount.from(99));
    });

    it('retains pending skips if fee preflight fails after discovery', async () => {
      Wallet.prototype.batchRestore = mock(async () => ({
        proofs: [makeProof(16, 'available'), makeProof(8, 'pending')],
      }));
      Wallet.prototype.checkProofsStates = mock(
        async () => [{ state: 'UNSPENT' }, { state: 'PENDING' }] as ProofState[],
      );
      const error = new Error('unknown fee');
      Wallet.prototype.getFeesForProofs = mock(() => {
        throw error;
      });
      expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed)).toMatchObject({
        status: 'failed',
        error,
        pending: { count: 1, amount: Amount.from(8) },
      });
    });

    it.each(['init', 'prepare'] as const)(
      'retains known pending skips when %s rejects',
      async (method) => {
        Wallet.prototype.batchRestore = mock(async () => ({
          proofs: [makeProof(16, 'available'), makeProof(8, 'pending')],
        }));
        Wallet.prototype.checkProofsStates = mock(
          async () => [{ state: 'UNSPENT' }, { state: 'PENDING' }] as ProofState[],
        );
        Wallet.prototype.getFeesForProofs = mock(() => Amount.from(1));
        const error = new Error('preparation rejected');
        receive[method] = mock(async () => {
          throw error;
        });
        expect(await service.sweepKeyset(mintUrl, keysetId, bip39seed)).toEqual({
          keysetId,
          unit: 'sat',
          status: 'failed',
          error,
          pending: { count: 1, amount: Amount.from(8) },
        });
      },
    );
  });

  describe('restoreKeyset', () => {
    it('commits the proof at counter zero and publishes only committed changes', async () => {
      const repositories = new MemoryRepositories();
      await repositories.init();
      const bus = new EventBus<CoreEvents>({ throwOnError: true });
      const saved = mock(async () => {
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          1,
        );
        throw new Error('listener failed');
      });
      bus.on('proofs:saved', saved);
      const restored = new WalletRestoreService(
        receive,
        new RepositoryCoreTransactionRunner(repositories),
        requestProvider,
        logger,
        undefined,
        bus,
      );
      const wallet = {
        batchRestore: mock(async () => ({
          proofs: [makeProof(8, 'zero')],
          lastCounterWithSignature: 0,
        })),
        checkProofsStates: mock(async () => [{ state: 'PENDING' }]),
      } as unknown as Wallet;
      await restored.restoreKeyset(mintUrl, wallet, keysetId, 'USD');
      const proof = await repositories.proofRepository.getProofBySecret(mintUrl, 'zero');
      expect(proof?.state).toBe('pending');
      expect(proof?.unit).toBe('usd');
      await restored.restoreKeyset(mintUrl, wallet, keysetId, 'USD');
      expect(saved).toHaveBeenCalledTimes(1);
    });

    it.each(['UNSPENT', 'SPENT'] as const)(
      'reconciles a pending proof on repeated Restore observing %s',
      async (observation) => {
        const repositories = new MemoryRepositories();
        await repositories.init();
        const bus = new EventBus<CoreEvents>({ throwOnError: true });
        const state = observation === 'UNSPENT' ? 'ready' : 'spent';
        const changed = mock(async (event: CoreEvents['proofs:state-changed']) => {
          expect(event).toEqual({ mintUrl, secrets: ['pending'], state });
          expect(
            (await repositories.proofRepository.getProofBySecret(mintUrl, 'pending'))?.state,
          ).toBe(state);
        });
        bus.on('proofs:state-changed', changed);
        const restored = new WalletRestoreService(
          receive,
          new RepositoryCoreTransactionRunner(repositories),
          requestProvider,
          logger,
          undefined,
          bus,
        );
        let remoteState: 'PENDING' | 'UNSPENT' | 'SPENT' = 'PENDING';
        const wallet = {
          batchRestore: async () => ({
            proofs: [makeProof(8, 'pending')],
            lastCounterWithSignature: 4,
          }),
          checkProofsStates: async () => [{ state: remoteState }],
        } as unknown as Wallet;
        await restored.restoreKeyset(mintUrl, wallet, keysetId);
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(0);
        expect(changed).not.toHaveBeenCalled();
        remoteState = observation;
        await restored.restoreKeyset(mintUrl, wallet, keysetId);
        await restored.restoreKeyset(mintUrl, wallet, keysetId);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(
          observation === 'UNSPENT' ? 1 : 0,
        );
      },
    );

    it('rejects malformed state checks without committing proofs or counters', async () => {
      const repositories = new MemoryRepositories();
      await repositories.init();
      const restored = new WalletRestoreService(
        receive,
        new RepositoryCoreTransactionRunner(repositories),
        requestProvider,
      );
      for (const states of [[], [{ state: 'UNKNOWN' }]]) {
        const wallet = {
          batchRestore: async () => ({
            proofs: [makeProof(8, 'bad')],
            lastCounterWithSignature: 10,
          }),
          checkProofsStates: async () => states,
        } as unknown as Wallet;
        await expect(restored.restoreKeyset(mintUrl, wallet, keysetId)).rejects.toThrow(
          'Malformed state check',
        );
        expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
        expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'bad')).toBeNull();
      }
    });
  });
});
