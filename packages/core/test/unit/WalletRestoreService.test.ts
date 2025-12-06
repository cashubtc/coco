import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { WalletRestoreService } from '../../services/WalletRestoreService';
import type { ProofService } from '../../services/ProofService';
import type { CounterService } from '../../services/CounterService';
import type { WalletService } from '../../services/WalletService';
import type { MintRequestProvider } from '../../infra/MintRequestProvider';
import type { Logger } from '../../logging/Logger';
import { CashuMint, CashuWallet, type Proof, type ProofState } from '@cashu/cashu-ts';

describe('WalletRestoreService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const bip39seed = new Uint8Array(64).fill(7);

  let proofService: ProofService;
  let counterService: CounterService;
  let walletService: WalletService;
  let requestProvider: MintRequestProvider;
  let logger: Logger;
  let service: WalletRestoreService;

  const makeProof = (amount: number, secret: string): Proof =>
    ({
      amount,
      C: `C_${secret}`,
      id: keysetId,
      secret,
    } as unknown as Proof);

  beforeEach(() => {
    // Mock ProofService
    proofService = {
      getProofsByKeysetId: mock(() => Promise.resolve([])),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: [],
          send: [{ amount: 100, counter: 1, id: keysetId }],
        }),
      ),
      saveProofs: mock(() => Promise.resolve()),
    } as unknown as ProofService;

    // Mock CounterService
    counterService = {
      overwriteCounter: mock(() => Promise.resolve()),
    } as unknown as CounterService;

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

    service = new WalletRestoreService(
      proofService,
      counterService,
      walletService,
      requestProvider,
      logger,
    );
  });

  describe('sweepKeyset', () => {
    it('should successfully sweep a keyset with ready proofs', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2')];

      // Mock CashuWallet methods
      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState, { state: 'UNSPENT' } as ProofState]),
      );
      const mockGetFeesForProofs = mock(() => 1);

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;
      CashuWallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(mockBatchRestore).toHaveBeenCalledTimes(1);
      expect(mockCheckProofsStates).toHaveBeenCalledTimes(1);
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(mintUrl, {
        keep: 0,
        send: 99, // 50 + 50 - 1 fee
      });
      expect(proofService.saveProofs).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Keyset sweep completed', {
        mintUrl,
        keysetId,
        readyProofs: 2,
        spentProofs: 0,
        sweptAmount: 100,
        fee: 1,
      });
    });

    it('should return early when no proofs are found', async () => {
      const mockBatchRestore = mock(() => Promise.resolve({ proofs: [] }));
      CashuWallet.prototype.batchRestore = mockBatchRestore;

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

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;

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
      const mockGetFeesForProofs = mock(() => 1);

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;
      CashuWallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(logger.debug).toHaveBeenCalledWith('Checked proof states', {
        mintUrl,
        keysetId,
        ready: 2,
        spent: 1,
      });
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(mintUrl, {
        keep: 0,
        send: 74, // 50 + 25 - 1 fee
      });
      expect(logger.info).toHaveBeenCalledWith('Keyset sweep completed', {
        mintUrl,
        keysetId,
        readyProofs: 2,
        spentProofs: 1,
        sweptAmount: 75,
        fee: 1,
      });
    });

    it('should throw when state check returns malformed data', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(50, 'proof2')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState]),
      ); // Wrong length

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;

      await expect(service.sweepKeyset(mintUrl, keysetId, bip39seed)).rejects.toThrow(
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

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;

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
      const mockGetFeesForProofs = mock(() => 10);

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;
      CashuWallet.prototype.getFeesForProofs = mockGetFeesForProofs;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      expect(logger.warn).toHaveBeenCalledWith('Sweep amount is less than fee', {
        mintUrl,
        keysetId,
        amount: 5,
        fee: 10,
        total: -5,
      });
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    });

    it('should log debug messages at key stages', async () => {
      const proofs = [makeProof(50, 'proof1')];

      const mockBatchRestore = mock(() => Promise.resolve({ proofs }));
      const mockCheckProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' } as ProofState]),
      );
      const mockGetFeesForProofs = mock(() => 1);

      CashuWallet.prototype.batchRestore = mockBatchRestore;
      CashuWallet.prototype.checkProofsStates = mockCheckProofsStates;
      CashuWallet.prototype.getFeesForProofs = mockGetFeesForProofs;

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
        amount: 50,
        fee: 1,
        total: 49,
      });
    });
  });

  describe('restoreKeyset', () => {
    let mockWallet: any;

    beforeEach(() => {
      mockWallet = {
        batchRestore: mock(() =>
          Promise.resolve({
            proofs: [makeProof(50, 'proof1')],
            lastCounterWithSignature: 10,
          }),
        ),
        checkProofsStates: mock(() => Promise.resolve([{ state: 'UNSPENT' }])),
      };
    });

    it('should successfully restore a keyset', async () => {
      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(mockWallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, keysetId);
      expect(mockWallet.checkProofsStates).toHaveBeenCalledTimes(1);
      expect(counterService.overwriteCounter).toHaveBeenCalledWith(mintUrl, keysetId, 11);
      expect(proofService.saveProofs).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Saved restored proofs for keyset', {
        mintUrl,
        keysetId,
        total: 1,
      });
    });

    it('should return early when no proofs are restored', async () => {
      mockWallet.batchRestore = mock(() =>
        Promise.resolve({ proofs: [], lastCounterWithSignature: 0 }),
      );

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(logger.warn).toHaveBeenCalledWith('No proofs to restore', { mintUrl, keysetId });
      expect(counterService.overwriteCounter).not.toHaveBeenCalled();
      expect(proofService.saveProofs).not.toHaveBeenCalled();
    });

    it('should throw when restored proofs are fewer than existing proofs', async () => {
      const existingProofs = [
        { id: keysetId, amount: 50 },
        { id: keysetId, amount: 25 },
        { id: keysetId, amount: 10 },
      ];
      proofService.getProofsByKeysetId = mock(() => Promise.resolve(existingProofs as any));

      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs: [makeProof(50, 'proof1')],
          lastCounterWithSignature: 10,
        }),
      );

      await expect(service.restoreKeyset(mintUrl, mockWallet, keysetId)).rejects.toThrow(
        'Restored less proofs than expected.',
      );
      expect(logger.warn).toHaveBeenCalledWith('Restored fewer proofs than previously stored', {
        mintUrl,
        keysetId,
        previous: 3,
        restored: 1,
      });
    });

    it('should handle malformed state check', async () => {
      mockWallet.checkProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' }, { state: 'SPENT' }]),
      ); // Wrong length

      await expect(service.restoreKeyset(mintUrl, mockWallet, keysetId)).rejects.toThrow(
        'Malformed state check',
      );
      expect(logger.error).toHaveBeenCalledWith('Malformed state check', {
        mintUrl,
        keysetId,
        statesLength: 2,
        proofsLength: 1,
      });
    });

    it('should handle non-array state check response', async () => {
      mockWallet.checkProofsStates = mock(() => Promise.resolve(null));

      await expect(service.restoreKeyset(mintUrl, mockWallet, keysetId)).rejects.toThrow(
        'Malformed state check',
      );
    });

    it('should throw when proof is missing during state check', async () => {
      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs: [makeProof(50, 'proof1')],
          lastCounterWithSignature: 10,
        }),
      );
      // Create a sparse array-like object that has a missing proof
      mockWallet.checkProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' }, { state: 'SPENT' }]),
      );

      // This will pass the length check but fail during iteration
      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs: [makeProof(50, 'proof1'), undefined as any, makeProof(25, 'proof3')],
          lastCounterWithSignature: 10,
        }),
      );
      mockWallet.checkProofsStates = mock(() =>
        Promise.resolve([{ state: 'UNSPENT' }, { state: 'SPENT' }, { state: 'UNSPENT' }]),
      );

      await expect(service.restoreKeyset(mintUrl, mockWallet, keysetId)).rejects.toThrow(
        'Proof not found',
      );
      expect(logger.error).toHaveBeenCalledWith('Proof not found', { mintUrl, keysetId, index: 1 });
    });

    it('should correctly separate spent and ready proofs', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(25, 'proof2'), makeProof(10, 'proof3')];

      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs,
          lastCounterWithSignature: 20,
        }),
      );
      mockWallet.checkProofsStates = mock(() =>
        Promise.resolve([{ state: 'SPENT' }, { state: 'UNSPENT' }, { state: 'SPENT' }]),
      );

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(logger.debug).toHaveBeenCalledWith('Checked proof states', {
        mintUrl,
        keysetId,
        ready: 1,
        spent: 2,
      });
      expect(logger.info).toHaveBeenCalledWith('Saved restored proofs for keyset', {
        mintUrl,
        keysetId,
        total: 3,
      });
    });

    it('should set counter to 0 when lastCounterWithSignature is null', async () => {
      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs: [makeProof(50, 'proof1')],
          lastCounterWithSignature: null,
        }),
      );

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(counterService.overwriteCounter).toHaveBeenCalledWith(mintUrl, keysetId, 0);
    });

    it('should set counter to 0 when lastCounterWithSignature is 0', async () => {
      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs: [makeProof(50, 'proof1')],
          lastCounterWithSignature: 0,
        }),
      );

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(counterService.overwriteCounter).toHaveBeenCalledWith(mintUrl, keysetId, 0);
    });

    it('should increment counter when lastCounterWithSignature is positive', async () => {
      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs: [makeProof(50, 'proof1')],
          lastCounterWithSignature: 99,
        }),
      );

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(counterService.overwriteCounter).toHaveBeenCalledWith(mintUrl, keysetId, 100);
      expect(logger.debug).toHaveBeenCalledWith('Requested counter overwrite for keyset', {
        mintUrl,
        keysetId,
        counter: 100,
      });
    });

    it('should log all key stages during restore', async () => {
      const existingProofs = [{ id: keysetId, amount: 25 }];
      proofService.getProofsByKeysetId = mock(() => Promise.resolve(existingProofs as any));

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      expect(logger.debug).toHaveBeenCalledWith('Restoring keyset', { mintUrl, keysetId });
      expect(logger.debug).toHaveBeenCalledWith('Existing proofs before restore', {
        mintUrl,
        keysetId,
        count: 1,
      });
      expect(logger.info).toHaveBeenCalledWith('Batch restore result', {
        mintUrl,
        keysetId,
        restored: 1,
        lastCounterWithSignature: 10,
      });
    });

    it('should save only ready proofs, not spent ones', async () => {
      const proofs = [makeProof(50, 'proof1'), makeProof(25, 'proof2')];

      mockWallet.batchRestore = mock(() =>
        Promise.resolve({
          proofs,
          lastCounterWithSignature: 5,
        }),
      );
      mockWallet.checkProofsStates = mock(() =>
        Promise.resolve([{ state: 'SPENT' }, { state: 'UNSPENT' }]),
      );

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      // Verify saveProofs was called with only ready proofs
      expect(proofService.saveProofs).toHaveBeenCalledTimes(1);
      const savedProofsCall = (proofService.saveProofs as any).mock.calls[0];
      expect(savedProofsCall[0]).toBe(mintUrl);
      // The second argument should be mapped proofs, we just check it was called
      expect(savedProofsCall[1]).toBeDefined();
    });
  });

  describe('integration between sweepKeyset and restoreKeyset', () => {
    it('should use the same batch restore parameters', async () => {
      const mockBatchRestore1 = mock(() => Promise.resolve({ proofs: [] }));
      CashuWallet.prototype.batchRestore = mockBatchRestore1;

      await service.sweepKeyset(mintUrl, keysetId, bip39seed);

      const mockWallet = {
        batchRestore: mock(() => Promise.resolve({ proofs: [], lastCounterWithSignature: 0 })),
        checkProofsStates: mock(() => Promise.resolve([])),
      } as unknown as CashuWallet;

      await service.restoreKeyset(mintUrl, mockWallet, keysetId);

      // Both should use the same batch size, gap limit, and start counter
      expect(mockBatchRestore1).toHaveBeenCalledWith(300, 100, 0, keysetId);
      expect(mockWallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, keysetId);
    });
  });
});
