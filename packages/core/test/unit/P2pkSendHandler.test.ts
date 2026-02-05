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

  const makeInitOp = (
    id: string,
    overrides?: Partial<InitSendOperation>,
  ): InitSendOperation => ({
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
      send: mock(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 9)],
          send: [makeProof('send-1', 100)],
        }),
      ),
      checkProofsStates: mock(() =>
        Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }]),
      ),
      unit: 'sat',
    } as unknown as Wallet;

    // Mock ProofRepository
    proofRepository = {
      getAvailableProofs: mock(() =>
        Promise.resolve([
          makeCoreProof('input-1', 60),
          makeCoreProof('input-2', 50),
        ]),
      ),
      getProofsByOperationId: mock(() => Promise.resolve([])),
    } as unknown as ProofRepository;

    // Mock ProofService
    proofService = {
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

  const buildPrepareContext = (
    operation: InitSendOperation,
  ): BasePrepareContext => ({
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

  const buildFinalizeContext = (
    operation: PendingSendOperation,
  ): FinalizeContext => ({
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

  const buildRecoverContext = (
    operation: ExecutingSendOperation,
  ): RecoverExecutingContext => ({
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
      (proofRepository.getAvailableProofs as Mock<any>).mockImplementation(() =>
        Promise.resolve([makeCoreProof('input-1', 50)]), // Only 50 available
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
      expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
        mintUrl,
        { keep: 9, send: 100 },
      );
    });

    it('should emit send:prepared event', async () => {
      const events: any[] = [];
      eventBus.on('send:prepared', (e) => void events.push(e));

      const operation = makeInitOp('op-1');
      const ctx = buildPrepareContext(operation);

      await handler.prepare(ctx);

      expect(events.length).toBe(1);
      expect(events[0].operationId).toBe('op-1');
      expect(events[0].operation.state).toBe('prepared');
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
      it('should use p2pk output type with pubkey for send outputs', async () => {
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

        // Verify P2PK output config was used
        expect(capturedOutputConfig).toBeDefined();
        expect(capturedOutputConfig!.send).toEqual({
          type: 'p2pk',
          options: { pubkey: testPubkey },
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
          type: 'p2pk',
          options: { pubkey: customPubkey },
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

        // Verify proofs were saved with correct states
        const keepProofs = savedProofs.filter((p) => p.state === 'ready');
        const sendProofs = savedProofs.filter((p) => p.state === 'inflight');

        expect(keepProofs.length).toBeGreaterThanOrEqual(0);
        expect(sendProofs.length).toBeGreaterThan(0);
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
          expect(result.token).toBeDefined();
          expect(result.token.mint).toBe(mintUrl);
          expect(result.token.proofs).toContain(p2pkLockedProof);
        }
      });

      it('should emit send:pending event with token', async () => {
        const events: any[] = [];
        eventBus.on('send:pending', (e) => void events.push(e));

        const operation = makeExecutingOp('op-1');
        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        expect(events.length).toBe(1);
        expect(events[0].operationId).toBe('op-1');
        expect(events[0].token).toBeDefined();
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

        await expect(handler.execute(ctx)).rejects.toThrow(
          'Could not find all reserved proofs',
        );
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

      expect(proofService.releaseProofs).toHaveBeenCalledWith(
        mintUrl,
        ['input-1', 'input-2'],
      );
    });

    it('should emit send:finalized event', async () => {
      const events: any[] = [];
      eventBus.on('send:finalized', (e) => void events.push(e));

      const operation = makePendingOp('op-1');
      const ctx = buildFinalizeContext(operation);

      await handler.finalize(ctx);

      expect(events.length).toBe(1);
      expect(events[0].operationId).toBe('op-1');
      expect(events[0].operation.state).toBe('finalized');
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

        expect(proofService.releaseProofs).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
        );
      });
    });

    describe('pending state rollback', () => {
      it('should warn that P2PK tokens cannot be reclaimed', async () => {
        const operation = makePendingOp('op-1');
        const ctx = buildRollbackContext(operation);

        await handler.rollback(ctx);

        expect(logger.warn).toHaveBeenCalledWith(
          'P2PK tokens cannot be reclaimed - locked to recipient pubkey',
          { operationId: 'op-1' },
        );
      });

      it('should release input and keep proof reservations', async () => {
        const outputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makePendingOp('op-1', {
          inputProofSecrets: ['input-1'],
          outputData,
        });

        const ctx = buildRollbackContext(operation);
        await handler.rollback(ctx);

        // Should release input proofs
        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1']);
        // Should release keep proofs
        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['keep-1']);
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
      it('should recover keep proofs from outputData when swap succeeded', async () => {
        const outputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          inputProofSecrets: ['input-1'],
          outputData,
        });

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
          mintUrl,
          outputData,
        );
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

        expect(proofService.setProofState).toHaveBeenCalledWith(
          mintUrl,
          ['input-1'],
          'spent',
        );
      });

      it('should return FAILED with appropriate error message', async () => {
        const operation = makeExecutingOp('op-1');

        (mockWallet.checkProofsStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        if (result.status === 'FAILED') {
          expect(result.failed.error).toBe(
            'Recovered: P2PK swap succeeded but token never returned',
          );
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
          send: [
            makeProof('send-1', 50),
            makeProof('send-2', 50),
          ],
        }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PENDING');
      if (result.status === 'PENDING') {
        expect(result.token.proofs).toHaveLength(2);
      }
    });
  });
});
