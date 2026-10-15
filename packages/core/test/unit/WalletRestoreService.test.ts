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
import type { ProofService } from '../../services/ProofService';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { EventBus, type CoreEvents } from '../../events/index.ts';
import type { CoreProof } from '../../types.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import type { WalletService } from '../../services/WalletService';
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

  let proofService: ProofService;
  let repositories: MemoryRepositories;
  let transactionRunner: RepositoryCoreTransactionRunner;
  let eventBus: EventBus<CoreEvents>;
  let walletService: WalletService;
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
    // Mock ProofService
    proofService = {
      getProofsByKeysetId: mock(() => Promise.resolve([])),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: [],
          send: [{ amount: Amount.from(100), counter: 1, id: keysetId }],
        }),
      ),
      saveProofs: mock(() => Promise.resolve()),
    } as unknown as ProofService;

    repositories = new MemoryRepositories();
    transactionRunner = new RepositoryCoreTransactionRunner(repositories);
    eventBus = new EventBus<CoreEvents>();

    // Mock WalletService
    walletService = {
      getWalletWithActiveKeysetId: mock(() =>
        Promise.resolve({
          wallet: {
            send: mock(() =>
              Promise.resolve({
                send: [makeProof(100, 'send-proof')],
                keep: [],
              }),
            ),
          },
        }),
      ),
    } as unknown as WalletService;

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

    service = new WalletRestoreService(
      proofService,
      transactionRunner,
      walletService,
      requestProvider,
      logger,
      undefined,
      eventBus,
    );
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
        proofService,
        transactionRunner,
        walletService,
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

    it('only submits positively unspent sweep inputs', async () => {
      const proofs = ['unspent', 'pending', 'spent'].map((secret) => makeProof(50, secret));
      Wallet.prototype.batchRestore = mock(async () => ({ proofs }));
      Wallet.prototype.checkProofsStates = mock(
        async () =>
          [{ state: 'UNSPENT' }, { state: 'PENDING' }, { state: 'SPENT' }] as ProofState[],
      );
      Wallet.prototype.getFeesForProofs = mock(() => Amount.from(1));
      const walletResult = await walletService.getWalletWithActiveKeysetId(mintUrl, 'sat');
      const { wallet } = walletResult;
      walletService.getWalletWithActiveKeysetId = mock(async () => walletResult);
      await service.sweepKeyset(mintUrl, keysetId, bip39seed);
      expect(wallet.send).toHaveBeenCalledWith(
        Amount.from(49),
        [proofs[0]],
        undefined,
        expect.anything(),
      );
    });

    it.each(['PENDING', 'UNKNOWN', undefined])(
      'never sweeps ineligible state %s',
      async (state) => {
        Wallet.prototype.batchRestore = mock(async () => ({ proofs: [makeProof(50, 'pending')] }));
        Wallet.prototype.checkProofsStates = mock(async () => [{ state }] as ProofState[]);
        const walletResult = await walletService.getWalletWithActiveKeysetId(mintUrl, 'sat');
        const { wallet } = walletResult;
        walletService.getWalletWithActiveKeysetId = mock(async () => walletResult);
        if (state === 'PENDING') await service.sweepKeyset(mintUrl, keysetId, bip39seed);
        else
          await expect(service.sweepKeyset(mintUrl, keysetId, bip39seed)).rejects.toThrow(
            'Malformed state check',
          );
        expect(proofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
        expect(wallet.send).not.toHaveBeenCalled();
      },
    );

    it('should successfully sweep a keyset with ready proofs', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2')];

      // Mock Wallet methods
      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState, { state: 'UNSPENT' } as ProofState]),
      );
      const mockGetFeesForProofs = mock(() => Amount.from(1));

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;
      Wallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(mockBatchRestore).toHaveBeenCalledTimes(1);
      expect(mockCheckProofsStates).toHaveBeenCalledTimes(1);
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(mintUrl, {
        keep: { amount: Amount.zero(), unit: 'sat' },
        send: { amount: Amount.from(99), unit: 'sat' }, // 50 + 50 - 1 fee
      });
      expect(proofService.saveProofs).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Keyset sweep completed', {
        mintUrl,
        keysetId,
        readyProofs: 2,
        spentProofs: 0,
        sweptAmount: Amount.from(100),
        fee: Amount.from(1),
      });
    });

    it('should sweep with a unit-scoped wallet and persist swept proofs with that unit', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2')];

      Wallet.prototype.batchRestore = mock(() => Promise.resolve({ proofs }));
      Wallet.prototype.checkProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState, { state: 'UNSPENT' } as ProofState]),
      );
      Wallet.prototype.getFeesForProofs = mock(() => Amount.from(1));

      await service.sweepKeyset(mintUrl, keysetId, bip39seed, 'USD');

      expect(walletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(mintUrl, {
        keep: { amount: Amount.zero(), unit: 'usd' },
        send: { amount: Amount.from(99), unit: 'usd' },
      });

      const savedProofsCall = (proofService.saveProofs as any).mock.calls[0];
      expect(savedProofsCall[0]).toBe(mintUrl);
      expect(savedProofsCall[1].map((proof: { unit: string }) => proof.unit)).toEqual(['usd']);
    });

    it('should return early when no proofs are found', async () => {
      const mockBatchRestore = mock(() => Promise.resolve({ proofs: [] }));
      Wallet.prototype.batchRestore = mockBatchRestore;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(mockBatchRestore).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('No proofs to sweep', { mintUrl, keysetId });
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    });

    it('should return early when all proofs are spent', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'SPENT' } as ProofState, { state: 'SPENT' } as ProofState]),
      );

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(logger.warn).toHaveBeenCalledWith('No unspent proofs to sweep', {
        mintUrl,
        keysetId,
        spentCount: 2,
      });
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    });

    it('should handle mixed spent and ready proofs', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2'), makeProof(25, 'proof3')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([
          { state: 'SPENT' } as ProofState,
          { state: 'UNSPENT' } as ProofState,
          { state: 'UNSPENT' } as ProofState,
        ]),
      );
      const mockGetFeesForProofs = mock(() => Amount.from(1));

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;
      Wallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(logger.debug).toHaveBeenCalledWith('Checked proof states', {
        mintUrl,
        keysetId,
        ready: 2,
        spent: 1,
      });
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(mintUrl, {
        keep: { amount: Amount.zero(), unit: 'sat' },
        send: { amount: Amount.from(74), unit: 'sat' }, // 50 + 25 - 1 fee
      });
      expect(proofService.saveProofs).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Keyset sweep completed', {
        mintUrl,
        keysetId,
        readyProofs: 2,
        spentProofs: 1,
        sweptAmount: Amount.from(75),
        fee: Amount.from(1),
      });
    });

    it('should throw when state check returns malformed data', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState]),
      ); // Wrong length

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;

      await expect(service.sweepKeyset(mintUrl, keysetId, bip39seed)).rejects.toThrow(
        'Malformed state check',
      );
    });

    it('should throw when state check returns non-array', async () => {
      const proofs = [makeProof(50, 'proof1')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() => Promise.resolve(null as unknown as ProofState[]));

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;

      await expect(service.sweepKeyset(mintUrl, keysetId, bip39seed)).rejects.toThrow(
        'Malformed state check',
      );
    });

    it('should return early when sweep total is negative', async () => {
      const proofs = [makeProof(5, 'proof1')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState]),
      );
      // Mock a negative fee to create a negative total (edge case scenario)
      const mockGetFeesForProofs = mock(() => Amount.from(10));

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;
      Wallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(logger.warn).toHaveBeenCalledWith('Sweep amount is less than fee', {
        mintUrl,
        keysetId,
        amount: Amount.from(5),
        fee: Amount.from(10),
      });
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    });

    it('should log debug messages at key stages', async () => {
      const proofs = [makeProof(50, 'proof1')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState]),
      );
      const mockGetFeesForProofs = mock(() => Amount.from(1));

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;
      Wallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(logger.debug).toHaveBeenCalledWith('Sweeping keyset', { mintUrl, keysetId });
      expect(logger.debug).toHaveBeenCalledWith('Proofs found for sweep', {
        mintUrl,
        keysetId,
        count: 1,
      });
      expect(logger.debug).toHaveBeenCalledWith('Sweep calculation', {
        mintUrl,
        keysetId,
        amount: Amount.from(50),
        fee: Amount.from(1),
        total: Amount.from(49),
      });
    });
  });

  describe('restoreKeyset', () => {
    const remoteWallet = (
      proofs: Proof[] = [makeProof(50, 'proof1')],
      states: unknown = [{ state: 'UNSPENT' }],
      lastCounterWithSignature: number | null | undefined = 10,
    ): Wallet =>
      ({
        batchRestore: mock(async () => ({ proofs, lastCounterWithSignature })),
        checkProofsStates: mock(async () => states),
      }) as unknown as Wallet;

    const storedProof = (secret: string, overrides: Partial<CoreProof> = {}): CoreProof => ({
      ...makeProof(50, secret),
      mintUrl,
      unit: 'sat',
      state: 'ready',
      ...overrides,
    });

    it.each([
      [0, 0, 1],
      [null, 50, 50],
      [undefined, 50, 50],
      [10, 50, 50],
      [99, 50, 100],
    ])(
      'preserves the high-water mark (observed %s, existing %s)',
      async (last, existing, expected) => {
        await repositories.counterRepository.setCounter(mintUrl, keysetId, existing!);
        const wallet = remoteWallet();
        wallet.batchRestore = mock(async () => ({
          proofs: [makeProof(50, 'proof1')],
          lastCounterWithSignature: last,
        })) as Wallet['batchRestore'];
        await service.restoreKeyset(mintUrl, wallet, keysetId);
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          expected,
        );
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
      },
    );

    it('normalizes the mint URL and unit before persistence and event publication', async () => {
      const saved = mock(() => {});
      eventBus.on('proofs:saved', saved);
      await service.restoreKeyset('https://MINT.test:443/', remoteWallet(), keysetId, 'USD');
      const proofs = await repositories.proofRepository.getAvailableProofs(mintUrl);
      expect(proofs).toEqual([expect.objectContaining({ mintUrl, unit: 'usd', state: 'ready' })]);
      expect(saved).toHaveBeenCalledWith({ mintUrl, keysetId, proofs });
    });

    it('is idempotent and only publishes newly committed changes', async () => {
      const saved = mock(() => {});
      const counter = mock(() => {});
      eventBus.on('proofs:saved', saved);
      eventBus.on('counter:updated', counter);
      await service.restoreKeyset(mintUrl, remoteWallet(), keysetId);
      await service.restoreKeyset(mintUrl, remoteWallet(), keysetId);
      expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
      expect(saved).toHaveBeenCalledTimes(1);
      expect(counter).toHaveBeenCalledTimes(1);
    });

    it('skips pending and spent proofs but advances past all signatures', async () => {
      const proofs = ['ready', 'pending', 'spent'].map((secret) => makeProof(50, secret));
      await service.restoreKeyset(
        mintUrl,
        remoteWallet(proofs, [{ state: 'UNSPENT' }, { state: 'PENDING' }, { state: 'SPENT' }], 29),
        keysetId,
      );
      expect(
        (await repositories.proofRepository.getAvailableProofs(mintUrl)).map(
          (proof) => proof.secret,
        ),
      ).toEqual(['ready']);
      expect(
        await repositories.proofRepository.getProofsBySecrets(mintUrl, ['pending', 'spent']),
      ).toEqual([]);
      expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
        30,
      );
    });

    it('can import a skipped pending proof on a later Restore without lowering the counter', async () => {
      const proofs = [makeProof(50, 'pending')];
      const saved = mock(() => {});
      eventBus.on('proofs:saved', saved);
      await service.restoreKeyset(
        mintUrl,
        remoteWallet(proofs, [{ state: 'PENDING' }], 0),
        keysetId,
      );
      expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'pending')).toBeNull();
      expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(1);
      expect(saved).not.toHaveBeenCalled();
      await repositories.counterRepository.setCounter(mintUrl, keysetId, 20);
      await service.restoreKeyset(
        mintUrl,
        remoteWallet(proofs, [{ state: 'UNSPENT' }], 0),
        keysetId,
      );
      expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'pending')).toMatchObject(
        { state: 'ready' },
      );
      expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
        20,
      );
    });

    it('preserves reservations, attribution, witnesses, and inflight/spent state', async () => {
      const existing = [
        storedProof('reserved', { usedByOperationId: 'send', createdByOperationId: 'mint' }),
        storedProof('inflight', { state: 'inflight', usedByOperationId: 'melt' }),
        storedProof('spent', {
          state: 'spent',
          createdByOperationId: 'previous',
          witness: 'witness',
        }),
        storedProof('unobserved'),
      ];
      await repositories.proofRepository.saveProofs(mintUrl, existing);
      await service.restoreKeyset(
        mintUrl,
        remoteWallet(existing.slice(0, 3), [
          { state: 'UNSPENT' },
          { state: 'UNSPENT' },
          { state: 'UNSPENT' },
        ]),
        keysetId,
      );
      expect(
        await repositories.proofRepository.getProofsBySecrets(
          mintUrl,
          existing.map((proof) => proof.secret),
        ),
      ).toEqual(existing);
    });

    it('rereads ownership and counters changed while the remote state check was pending', async () => {
      const existing = storedProof('existing', { createdByOperationId: 'mint' });
      await repositories.proofRepository.saveProofs(mintUrl, [existing]);
      const checking = Promise.withResolvers<void>();
      const checked = Promise.withResolvers<ProofState[]>();
      const wallet = remoteWallet([existing]);
      wallet.checkProofsStates = mock(() => {
        checking.resolve();
        return checked.promise;
      });
      const restoring = service.restoreKeyset(mintUrl, wallet, keysetId);
      await checking.promise;
      try {
        await repositories.withTransaction(async (scope) => {
          await scope.proofRepository.reserveProofs(mintUrl, [existing.secret], 'melt');
          await scope.proofRepository.setProofState(mintUrl, [existing.secret], 'inflight');
          await scope.counterRepository.setCounter(mintUrl, keysetId, 70);
        });
      } finally {
        checked.resolve([{ state: 'UNSPENT' } as ProofState]);
      }
      await restoring;
      expect(await repositories.proofRepository.getProofBySecret(mintUrl, existing.secret)).toEqual(
        {
          ...existing,
          state: 'inflight',
          usedByOperationId: 'melt',
        },
      );
      expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
        70,
      );
    });

    it('retries local reconciliation against fresh state without repeating remote work or events', async () => {
      const existing = storedProof('existing', { usedByOperationId: 'send' });
      await repositories.proofRepository.saveProofs(mintUrl, [existing]);
      let attempts = 0;
      const runner = new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, async (work) => {
          try {
            return await repositories.withTransaction(async (scope) => {
              const result = await work(scope);
              if (++attempts === 1) throw new RepositoryTransactionConflictError('retry Restore');
              return result;
            });
          } catch (error) {
            // A competing transaction commits after the first Restore attempt rolls back.
            await repositories.withTransaction(async (scope) => {
              await scope.proofRepository.setProofState(mintUrl, [existing.secret], 'spent');
              await scope.counterRepository.setCounter(mintUrl, keysetId, 80);
            });
            throw error;
          }
        }),
      );
      service = new WalletRestoreService(
        proofService,
        runner,
        walletService,
        requestProvider,
        logger,
        undefined,
        eventBus,
      );
      const saved = mock(() => {});
      const counter = mock(() => {});
      eventBus.on('proofs:saved', saved);
      eventBus.on('counter:updated', counter);
      const wallet = remoteWallet(
        [existing, makeProof(50, 'new')],
        [{ state: 'UNSPENT' }, { state: 'UNSPENT' }],
      );
      await service.restoreKeyset(mintUrl, wallet, keysetId);
      expect(attempts).toBe(2);
      expect(wallet.batchRestore).toHaveBeenCalledTimes(1);
      expect(wallet.checkProofsStates).toHaveBeenCalledTimes(1);
      expect(await repositories.proofRepository.getProofBySecret(mintUrl, existing.secret)).toEqual(
        {
          ...existing,
          state: 'spent',
        },
      );
      expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([
        storedProof('new'),
      ]);
      expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
        80,
      );
      expect(saved).toHaveBeenCalledTimes(1);
      expect(counter).not.toHaveBeenCalled();
    });

    it.each(['UNSPENT', 'PENDING', 'SPENT'])(
      'rejects conflicting stored material even when remotely %s',
      async (state) => {
        const existing = storedProof('existing', { createdByOperationId: 'mint' });
        await repositories.proofRepository.saveProofs(mintUrl, [existing]);
        await repositories.counterRepository.setCounter(mintUrl, keysetId, 2);
        const saved = mock(() => {});
        const counter = mock(() => {});
        eventBus.on('proofs:saved', saved);
        eventBus.on('counter:updated', counter);
        await expect(
          service.restoreKeyset(
            mintUrl,
            remoteWallet(
              [makeProof(50, 'new'), { ...makeProof(50, 'existing'), C: 'conflict' }],
              [{ state: 'UNSPENT' }, { state }],
            ),
            keysetId,
          ),
        ).rejects.toThrow('Conflicting proof');
        expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'new')).toBeNull();
        expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'existing')).toEqual(
          existing,
        );
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          2,
        );
        expect(saved).not.toHaveBeenCalled();
        expect(counter).not.toHaveBeenCalled();
      },
    );

    it.each([
      null,
      [],
      [{ state: 'UNKNOWN' }],
      [null],
      [{}],
      [{ state: 'UNSPENT' }, { state: 'SPENT' }],
    ])('rejects malformed state observations without persistence', async (states) => {
      await expect(
        service.restoreKeyset(mintUrl, remoteWallet(undefined, states), keysetId),
      ).rejects.toThrow('Malformed state check');
      expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
      expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
    });

    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
      'rejects invalid counter %s atomically',
      async (last) => {
        await expect(
          service.restoreKeyset(mintUrl, remoteWallet(undefined, undefined, last), keysetId),
        ).rejects.toThrow('Invalid restored counter');
        expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
      },
    );

    it('rejects mixed keysets and duplicate observations before persistence', async () => {
      const proof = makeProof(50, 'proof1');
      await expect(
        service.restoreKeyset(mintUrl, remoteWallet([{ ...proof, id: 'wrong' }]), keysetId),
      ).rejects.toThrow('Invalid restored proof');
      await expect(
        service.restoreKeyset(
          mintUrl,
          remoteWallet([proof, proof], [{ state: 'UNSPENT' }, { state: 'PENDING' }]),
          keysetId,
        ),
      ).rejects.toThrow('Invalid restored proof');
      expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    });

    it('preserves a counter when no signatures are found', async () => {
      await repositories.counterRepository.setCounter(mintUrl, keysetId, 90);
      const wallet = remoteWallet([], [], null);
      await service.restoreKeyset(mintUrl, wallet, keysetId);
      expect(wallet.checkProofsStates).not.toHaveBeenCalled();
      expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
        90,
      );
    });

    it('rolls back counter and imported proofs on a persistence failure', async () => {
      const runner = new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, (work) =>
          repositories.withTransaction((scope) =>
            work({
              ...scope,
              proofRepository: new Proxy(scope.proofRepository, {
                get(target, property, receiver) {
                  if (property === 'saveProofs')
                    return async (...args: Parameters<typeof target.saveProofs>) => {
                      await target.saveProofs(...args);
                      throw new Error('storage failure');
                    };
                  const value = Reflect.get(target, property, receiver);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }),
            }),
          ),
        ),
      );
      service = new WalletRestoreService(
        proofService,
        runner,
        walletService,
        requestProvider,
        logger,
        undefined,
        eventBus,
      );
      await expect(service.restoreKeyset(mintUrl, remoteWallet(), keysetId)).rejects.toThrow(
        'storage failure',
      );
      expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
      expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
    });

    it('keeps remote calls outside the transaction and publishes only committed state', async () => {
      let inTransaction = false;
      const runner = new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, async (work) => {
          inTransaction = true;
          try {
            return await repositories.withTransaction(work);
          } finally {
            inTransaction = false;
          }
        }),
      );
      service = new WalletRestoreService(
        proofService,
        runner,
        walletService,
        requestProvider,
        logger,
        undefined,
        eventBus,
      );
      const wallet = remoteWallet();
      wallet.batchRestore = mock(async () => {
        expect(inTransaction).toBe(false);
        return { proofs: [makeProof(50, 'proof1')], lastCounterWithSignature: 10 };
      });
      wallet.checkProofsStates = mock(async () => {
        expect(inTransaction).toBe(false);
        return [{ state: 'UNSPENT' } as ProofState];
      });
      const observed: string[] = [];
      eventBus.on('counter:updated', async (counter) => {
        expect(inTransaction).toBe(false);
        expect(counter.counter).toBe(11);
        expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toHaveLength(1);
        observed.push('counter');
        throw new Error('counter listener failed');
      });
      eventBus.on('proofs:saved', async (event) => {
        expect(inTransaction).toBe(false);
        expect(event.proofs).toHaveLength(1);
        expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(
          11,
        );
        observed.push('proofs');
        throw new Error('proof listener failed');
      });
      await service.restoreKeyset(mintUrl, wallet, keysetId);
      expect(observed).toEqual(['counter', 'proofs']);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('integration between sweepKeyset and restoreKeyset', () => {
    it('should use the same batch restore parameters', async () => {
      const mockBatchRestore1 = mock(() => Promise.resolve({ proofs: [] }));
      Wallet.prototype.batchRestore = mockBatchRestore1;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      const mockWallet = {
        batchRestore: mock(() => Promise.resolve({ proofs: [], lastCounterWithSignature: 0 })),
        checkProofsStates: mock(() => Promise.resolve([])),
      } as unknown as Wallet;

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      // Both should use the same batch size, gap limit, and start counter
      expect(mockBatchRestore1).toHaveBeenCalledWith({
        gapLimit: 300,
        batchSize: 100,
        counter: 0,
        keysetId,
        filterSpent: false,
      });
      expect(mockWallet.batchRestore).toHaveBeenCalledWith({
        gapLimit: 300,
        batchSize: 100,
        counter: 0,
        keysetId,
        filterSpent: false,
      });
    });
  });
});
