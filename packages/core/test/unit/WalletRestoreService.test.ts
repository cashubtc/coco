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
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
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
  let transactionRunner: RepositoryCoreTransactionRunner;
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

    transactionRunner = new RepositoryCoreTransactionRunner(new MemoryRepositories());

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

      expect(logger.warn).toHaveBeenCalledWith('No ready proofs to sweep, all spent', {
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

      expect(service.sweepKeyset(mintUrl, keysetId, bip39seed)).rejects.toThrow(
        'Malformed state check',
      );
      expect(logger.error).toHaveBeenCalledWith('Malformed state check', {
        mintUrl,
        keysetId,
        statesLength: 1,
        proofsLength: 2,
      });
    });

    it('should throw when state check returns non-array', async () => {
      const proofs = [makeProof(50, 'proof1')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() => Promise.resolve(null as unknown as ProofState[]));

      Wallet.prototype.batchRestore = mockBatchRestore;
      Wallet.prototype.checkProofsStates = mockCheckProofsStates;

      expect(service.sweepKeyset(mintUrl, keysetId, bip39seed)).rejects.toThrow(
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
        proofService,
        new RepositoryCoreTransactionRunner(repositories),
        walletService,
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

    it('rejects malformed state checks without committing proofs or counters', async () => {
      const repositories = new MemoryRepositories();
      await repositories.init();
      const restored = new WalletRestoreService(
        proofService,
        new RepositoryCoreTransactionRunner(repositories),
        walletService,
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
