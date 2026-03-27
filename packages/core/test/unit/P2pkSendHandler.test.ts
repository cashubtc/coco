import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { ProofService } from '../../services/ProofService';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { Logger } from '../../logging/Logger';
import type { CoreProof } from '../../types';
import type { ProofRepository } from '../../repositories';
import { ProofValidationError } from '../../models/Error';
import type {
  InitSendOperation,
  PreparedSendOperation,
  ExecutingSendOperation,
  PendingSendOperation,
} from '../../operations/send/SendOperation';
import type {
  BasePrepareContext,
  ExecuteContext,
  FinalizeContext,
  RollbackContext,
  RecoverExecutingContext,
} from '../../operations/send/SendMethodHandler';
import type { Wallet, Proof, OutputConfig } from '@cashu/cashu-ts';

describe('P2pkSendHandler', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const testPubkey = '02abc123def456...'; // Example P2PK pubkey

  let handler: P2pkSendHandler;
  let proofRepository: ProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let mockWallet: Wallet;

  // ============================================================================
  // Test Helpers
  // ============================================================================

  const makeProof = (secret: string, amount = 10, overrides?: Partial<Proof>): Proof =>
    ({
      amount,
      C: `C_${secret}`,
      id: keysetId,
      secret,
      ...overrides,
    }) as Proof;

  const makeCoreProof = (secret: string, amount = 10, overrides?: Partial<CoreProof>): CoreProof =>
    ({
      amount,
      C: `C_${secret}`,
      id: keysetId,
      secret,
      mintUrl,
      state: 'ready',
      ...overrides,
    }) as CoreProof;

  /**
   * Creates mock OutputData for testing swap operations.
   */
  const createMockOutputData = (keepSecrets: string[], sendSecrets: string[]) => ({
    keep: keepSecrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_keep_${secret}` },
      blindingFactor: '1234567890abcdef',
      secret: Buffer.from(secret).toString('hex'),
    })),
    send: sendSecrets.map((secret) => ({
      blindedMessage: { amount: 10, id: keysetId, B_: `B_send_${secret}` },
      blindingFactor: 'abcdef1234567890',
      secret: Buffer.from(secret).toString('hex'),
    })),
  });

  const makeInitOp = (id: string, overrides?: Partial<InitSendOperation>): InitSendOperation => ({
    id,
    state: 'init',
    mintUrl,
    amount: 100,
    method: 'p2pk',
    methodData: { pubkey: testPubkey },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    ...overrides,
  });

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedSendOperation>,
  ): PreparedSendOperation => ({
    id,
    state: 'prepared',
    mintUrl,
    amount: 100,
    method: 'p2pk',
    methodData: { pubkey: testPubkey },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    needsSwap: true, // P2PK always needs swap
    fee: 1,
    inputAmount: 101,
    inputProofSecrets: ['input-1', 'input-2'],
    outputData: createMockOutputData(['keep-1'], ['send-1']),
    ...overrides,
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingSendOperation>,
  ): ExecutingSendOperation => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingSendOperation>,
  ): PendingSendOperation => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
  });

  // ============================================================================
  // Setup
  // ============================================================================

  beforeEach(() => {
    handler = new P2pkSendHandler();
    eventBus = new EventBus<CoreEvents>();

    // Mock wallet
    mockWallet = {
      selectProofsToSend: mock(() => ({
        send: [makeProof('input-1', 60), makeProof('input-2', 50)],
        keep: [],
      })),
      getFeesForProofs: mock(() => 1),
      getKeyset: mock(() => ({ id: keysetId, keys: { 1: 'pubkey' } })),
      send: mock(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 9)],
          send: [makeProof('send-1', 100)],
        }),
      ),
      checkProofsStates: mock(() => Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }])),
      unit: 'sat',
    } as unknown as Wallet;

    // Mock ProofRepository
    proofRepository = {
      getAvailableProofs: mock(() =>
        Promise.resolve([makeCoreProof('input-1', 60), makeCoreProof('input-2', 50)]),
      ),
      getProofsByOperationId: mock(() => Promise.resolve([])),
    } as unknown as ProofRepository;

    // Mock ProofService
    proofService = {
      selectProofsToSend: mock(async (_mintUrl: string, amount: number, includeFees = true) => {
        const proofs = await proofRepository.getAvailableProofs(mintUrl);
        const totalAvailable = proofs.reduce((acc, proof) => acc + proof.amount, 0);
        if (totalAvailable < amount) {
          throw new ProofValidationError(
            `Insufficient balance: need ${amount}, have ${totalAvailable}`,
          );
        }
        return mockWallet.selectProofsToSend(proofs, amount, includeFees).send;
      }),
      reserveProofs: mock(() => Promise.resolve({ amount: 110 })),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: createMockOutputData(['keep-1'], []).keep,
          send: createMockOutputData([], ['send-1']).send,
          sendAmount: 100,
          keepAmount: 9,
        }),
      ),
      setProofState: mock(() => Promise.resolve()),
      saveProofs: mock(() => Promise.resolve()),
      releaseProofs: mock(() => Promise.resolve()),
      recoverProofsFromOutputData: mock(() => Promise.resolve([])),
    } as unknown as ProofService;

    // Mock MintService
    mintService = {
      isTrustedMint: mock(() => Promise.resolve(true)),
    } as unknown as MintService;

    // Mock WalletService
    walletService = {
      getWalletWithActiveKeysetId: mock(() =>
        Promise.resolve({
          wallet: mockWallet,
          keysetId,
          keyset: { id: keysetId },
          keys: { keys: { 1: 'pubkey' }, id: keysetId },
        }),
      ),
      getWallet: mock(() => Promise.resolve(mockWallet)),
    } as unknown as WalletService;

    // Mock Logger
    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as Logger;
  });

  // ============================================================================
  // Context Builders
  // ============================================================================

  const buildPrepareContext = (operation: InitSendOperation): BasePrepareContext => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildExecuteContext = (
    operation: ExecutingSendOperation,
    reservedProofs: Proof[] = [],
  ): ExecuteContext => ({
    operation,
    wallet: mockWallet,
    reservedProofs,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildFinalizeContext = (operation: PendingSendOperation): FinalizeContext => ({
    operation,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildRollbackContext = (
    operation: PreparedSendOperation | PendingSendOperation,
  ): RollbackContext => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildRecoverContext = (operation: ExecutingSendOperation): RecoverExecutingContext => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  // ============================================================================
  // Prepare Phase Tests
  // ============================================================================

  describe('prepare', () => {
    it('should throw if pubkey is missing from methodData', async () => {
      const operation = makeInitOp('op-1', {
        methodData: {}, // No pubkey
      });
      const ctx = buildPrepareContext(operation);

      await expect(handler.prepare(ctx)).rejects.toThrow(
        'P2PK send requires a pubkey in methodData',
      );
    });

    it('should throw if balance is insufficient', async () => {
      const operation = makeInitOp('op-1', { amount: 1000 }); // More than available
      (proofRepository.getAvailableProofs as Mock<any>).mockImplementation(
        () => Promise.resolve([makeCoreProof('input-1', 50)]), // Only 50 available
      );

      const ctx = buildPrepareContext(operation);

      await expect(handler.prepare(ctx)).rejects.toThrow(
        'Insufficient balance: need 1000, have 50',
      );
    });

    it('should always set needsSwap to true for P2PK', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      const result = await handler.prepare(ctx);

      expect(result.needsSwap).toBe(true);
    });

    it('should prepare operation with correct structure', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      const result = await handler.prepare(ctx);

      expect(result.state).toBe('prepared');
      expect(result.method).toBe('p2pk');
      expect(result.methodData).toEqual({ pubkey: testPubkey });
      expect(result.inputProofSecrets).toEqual(['input-1', 'input-2']);
      expect(result.outputData).toBeDefined();
    });

    it('should reserve proofs for the operation', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      expect(proofService.reserveProofs).toHaveBeenCalledWith(
        mintUrl,
        ['input-1', 'input-2'],
        'op-1',
      );
    });

    it('should create outputs for keep and send amounts', async () => {
      const operation = makeInitOp('op-1', { amount: 100 });
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      // Selected amount (110) - amount (100) - fee (1) = 9 keep
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(mintUrl, {
        keep: 9,
        send: 0,
      });
    });

    it('should log preparation with pubkey', async () => {
      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      expect(logger.info).toHaveBeenCalledWith(
        'P2PK send operation prepared',
        expect.objectContaining({
          operationId: 'op-1',
          pubkey: testPubkey,
        }),
      );
    });
  });

  // ============================================================================
  // Execute Phase Tests - P2PK Locked Proof Creation
  // ============================================================================

  describe('execute', () => {
    describe('P2PK locked proof creation', () => {
      it('should use prepared custom outputs for send outputs', async () => {
        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        // Capture the OutputConfig passed to wallet.send
        let capturedOutputConfig: OutputConfig | undefined;
        (mockWallet.send as Mock<any>).mockImplementation(
          (amount: number, proofs: Proof[], _opts: any, outputConfig: OutputConfig) => {
            capturedOutputConfig = outputConfig;
            return Promise.resolve({
              keep: [makeProof('keep-1', 9)],
              send: [makeProof('send-1', 100)],
            });
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        // Verify the prepared outputs were reused during execution
        expect(capturedOutputConfig).toBeDefined();
        expect(capturedOutputConfig!.send).toEqual({
          type: 'custom',
          data: expect.any(Array),
        });
        expect(capturedOutputConfig!.keep).toEqual({
          type: 'custom',
          data: expect.any(Array),
        });
      });

      it('should pass the correct pubkey from methodData', async () => {
        const customPubkey = '03custom_pubkey_hex...';
        const operation = makeExecutingOp('op-1', {
          methodData: { pubkey: customPubkey },
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        let capturedOutputConfig: OutputConfig | undefined;
        (mockWallet.send as Mock<any>).mockImplementation(
          (_amount: number, _proofs: Proof[], _opts: any, outputConfig: OutputConfig) => {
            capturedOutputConfig = outputConfig;
            return Promise.resolve({
              keep: [],
              send: [makeProof('send-1', 100)],
            });
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        expect(capturedOutputConfig!.send).toEqual({
          type: 'custom',
          data: expect.any(Array),
        });
      });

      it('should throw if pubkey is missing during execute', async () => {
        const operation = makeExecutingOp('op-1', {
          methodData: {}, // No pubkey
        });
        const inputProofs = [makeProof('input-1', 110)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow(
          'P2PK send requires a pubkey in methodData',
        );
      });

      it('should throw if outputData is missing', async () => {
        const operation = makeExecutingOp('op-1', {
          outputData: undefined,
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow(
          'Missing output data for P2PK swap operation',
        );
      });
    });

    describe('proof state management', () => {
      it('should save keep proofs as ready and send proofs as inflight', async () => {
        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        let savedProofs: any[] = [];
        (proofService.saveProofs as Mock<any>).mockImplementation(
          (_mintUrl: string, proofs: any[]) => {
            savedProofs = proofs;
            return Promise.resolve();
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        const keepProofs = savedProofs.filter((p) => p.state === 'ready');
        const sendProofs = savedProofs.filter((p) => p.state === 'inflight');

        expect(keepProofs).toHaveLength(1);
        expect(sendProofs).toHaveLength(1);
        expect(sendProofs[0]?.secret).toBe('send-1');
      });

      it('should mark input proofs as spent after swap', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1', 'input-2'],
        });
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        expect(proofService.setProofState).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
          'spent',
        );
      });
    });

    describe('token creation', () => {
      it('should return a token with P2PK locked proofs', async () => {
        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const p2pkLockedProof = makeProof('p2pk-locked-1', 100);
        (mockWallet.send as Mock<any>).mockImplementation(() =>
          Promise.resolve({
            keep: [],
            send: [p2pkLockedProof],
          }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(result.status).toBe('PENDING');
        if (result.status === 'PENDING') {
          const { token } = result;
          expect(token).toBeDefined();
          expect(token?.mint).toBe(mintUrl);
          expect(token?.proofs).toContain(p2pkLockedProof);
          expect(result.pending.token).toEqual(token);
        }
      });
    });

    describe('error handling', () => {
      it('should throw if reserved proofs do not match input secrets', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1', 'input-2', 'input-3'], // 3 expected
        });
        // Only 2 proofs provided
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow('Could not find all reserved proofs');
      });
    });
  });

  // ============================================================================
  // Finalize Phase Tests
  // ============================================================================

  describe('finalize', () => {
    it('should release input proof reservations', async () => {
      const operation = makePendingOp('op-1', {
        inputProofSecrets: ['input-1', 'input-2'],
      });

      const ctx = buildFinalizeContext(operation);
      await handler.finalize(ctx);

      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
    });

    it('should release send and keep proof reservations when present', async () => {
      const operation = makePendingOp('op-1');
      const ctx = buildFinalizeContext(operation);

      await handler.finalize(ctx);

      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['send-1']);
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['keep-1']);
    });
  });

  // ============================================================================
  // Rollback Phase Tests
  // ============================================================================

  describe('rollback', () => {
    describe('prepared state rollback', () => {
      it('should release reserved proofs for prepared operation', async () => {
        const operation = makePreparedOp('op-1', {
          inputProofSecrets: ['input-1', 'input-2'],
        });

        const ctx = buildRollbackContext(operation);
        await handler.rollback(ctx);

        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
      });
    });

    describe('pending state rollback', () => {
      it('should reject pending rollback because P2PK tokens cannot be reclaimed', async () => {
        const operation = makePendingOp('op-1');
        const ctx = buildRollbackContext(operation);

        await expect(handler.rollback(ctx)).rejects.toThrow(
          'P2PK Send Operation in pending state can not be rolled back.',
        );
      });

      it('should not release reservations for pending rollback', async () => {
        const outputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makePendingOp('op-1', {
          inputProofSecrets: ['input-1'],
          outputData,
        });

        const ctx = buildRollbackContext(operation);
        await expect(handler.rollback(ctx)).rejects.toThrow(
          'P2PK Send Operation in pending state can not be rolled back.',
        );
        expect(proofService.releaseProofs).not.toHaveBeenCalled();
      });
    });
  });

  // ============================================================================
  // Recovery Tests
  // ============================================================================

  describe('recoverExecuting', () => {
    describe('swap never executed', () => {
      it('should rollback when input proofs are UNSPENT', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        if (result.status === 'FAILED') {
          expect(result.failed.error).toBe('Recovered: P2PK swap never executed');
        }
        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1']);
      });
    });

    describe('swap executed', () => {
      it('should recover keep proofs and resurface the token when swap succeeded', async () => {
        const outputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
          outputData,
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );
        let savedProofs: any[] = [];
        (proofService.saveProofs as Mock<any>).mockImplementation(
          (_mintUrl: string, proofs: any[]) => {
            savedProofs = [...savedProofs, ...proofs];
            return Promise.resolve();
          },
        );
        (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(
          (_mintUrl: string, serializedOutputData: any, options?: any) => {
            if (serializedOutputData.send.length > 0) {
              expect(options).toEqual({ persistRecoveredProofs: false });
              return Promise.resolve([makeProof('send-1', 100)]);
            }
            return Promise.resolve([]);
          },
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PENDING');
        expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
          mintUrl,
          {
            keep: outputData.keep,
            send: [],
          },
          {
            createdByOperationId: 'op-1',
          },
        );
        expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
          mintUrl,
          {
            keep: [],
            send: outputData.send,
          },
          {
            persistRecoveredProofs: false,
          },
        );
        if (result.status === 'PENDING') {
          expect(result.token?.proofs).toEqual([makeProof('send-1', 100)]);
          expect(result.pending.token).toEqual(result.token);
        }
        expect(savedProofs.filter((proof) => proof.secret === 'send-1')).toEqual([
          expect.objectContaining({
            secret: 'send-1',
            state: 'inflight',
            createdByOperationId: 'op-1',
          }),
        ]);
      });

      it('should mark input proofs as spent after recovery', async () => {
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        await handler.recoverExecuting(ctx);

        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      });

      it('should return pending without a token when the reconstructed send proofs are already spent', async () => {
        const operation = makeExecutingOp('op-1');

        (mockWallet.checkProofsStates as Mock<any>)
          .mockImplementationOnce(() => Promise.resolve([{ state: 'SPENT', Y: 'y1' }]))
          .mockImplementationOnce(() => Promise.resolve([{ state: 'SPENT', Y: 'y-send' }]));
        (proofService.recoverProofsFromOutputData as Mock<any>).mockImplementation(() =>
          Promise.resolve([]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PENDING');
        if (result.status === 'PENDING') {
          expect(result.token).toBeUndefined();
          expect(result.pending.token).toBeUndefined();
        }
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty keep outputs gracefully', async () => {
      const operation = makeExecutingOp('op-1');
      const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

      (mockWallet.send as Mock<any>).mockImplementation(() =>
        Promise.resolve({
          keep: [], // No keep proofs
          send: [makeProof('send-1', 100)],
        }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PENDING');
    });

    it('should handle multiple send proofs', async () => {
      const operation = makeExecutingOp('op-1');
      const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

      (mockWallet.send as Mock<any>).mockImplementation(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 9)],
          send: [makeProof('send-1', 50), makeProof('send-2', 50)],
        }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PENDING');
      if (result.status === 'PENDING') {
        expect(result.token?.proofs).toHaveLength(2);
      }
    });
  });
});
