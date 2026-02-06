import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { MeltBolt11Handler } from '../../infra/handlers/MeltBolt11Handler';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { ProofService } from '../../services/ProofService';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { Logger } from '../../logging/Logger';
import type { CoreProof } from '../../types';
import type { ProofRepository } from '../../repositories';
import type { MintAdapter } from '../../infra';
import type {
  InitMeltOperation,
  PreparedMeltOperation,
  ExecutingMeltOperation,
  PendingMeltOperation,
} from '../../operations/melt/MeltOperation';
import type {
  MeltMethodMeta,
  BasePrepareContext,
  ExecuteContext,
  FinalizeContext,
  PendingContext,
  RollbackContext,
  RecoverExecutingContext,
} from '../../operations/melt/MeltMethodHandler';
import type { Wallet, Proof, SerializedBlindedSignature } from '@cashu/cashu-ts';
import { SWAP_THRESHOLD_RATIO } from '../../infra/handlers/MeltBolt11Handler.utils';

describe('MeltBolt11Handler', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';
  const invoice = 'lnbc1000n1...';

  let handler: MeltBolt11Handler;
  let proofRepository: ProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
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
    overrides?: Partial<InitMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): InitMeltOperation & MeltMethodMeta<'bolt11'> => ({
    id,
    state: 'init',
    mintUrl,
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    ...overrides,
  });

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): PreparedMeltOperation & MeltMethodMeta<'bolt11'> => ({
    id,
    state: 'prepared',
    mintUrl,
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    quoteId: 'quote-123',
    amount: 100,
    fee_reserve: 10,
    swap_fee: 0,
    needsSwap: false,
    inputAmount: 110,
    inputProofSecrets: ['input-1', 'input-2'],
    changeOutputData: createMockOutputData(['change-1'], []),
    ...overrides,
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): ExecutingMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): PendingMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
  });

  // ============================================================================
  // Setup
  // ============================================================================

  beforeEach(() => {
    handler = new MeltBolt11Handler();
    eventBus = new EventBus<CoreEvents>();

    // Mock wallet
    mockWallet = {
      createMeltQuote: mock(() =>
        Promise.resolve({
          quote: 'quote-123',
          amount: 100,
          fee_reserve: 10,
        }),
      ),
      getFeesForProofs: mock(() => 1),
      send: mock(() =>
        Promise.resolve({
          keep: [makeProof('keep-1', 50)],
          send: [makeProof('send-1', 60)],
        }),
      ),
    } as unknown as Wallet;

    // Mock ProofRepository
    proofRepository = {
      getProofsByOperationId: mock(() => Promise.resolve([])),
    } as unknown as ProofRepository;

    // Mock ProofService
    proofService = {
      selectProofsToSend: mock(() =>
        Promise.resolve([makeProof('input-1', 60), makeProof('input-2', 50)]),
      ),
      reserveProofs: mock(() => Promise.resolve({ amount: 110 })),
      createBlankOutputs: mock(() => Promise.resolve([])),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({ keep: [], send: [], sendAmount: 0, keepAmount: 0 }),
      ),
      setProofState: mock(() => Promise.resolve()),
      saveProofs: mock(() => Promise.resolve()),
      restoreProofsToReady: mock(() => Promise.resolve()),
      releaseProofs: mock(() => Promise.resolve()),
      unblindAndSaveChangeProofs: mock(() => Promise.resolve()),
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

    // Mock MintAdapter
    mintAdapter = {
      customMeltBolt11: mock(() =>
        Promise.resolve({
          state: 'PAID' as const,
          change: [],
        }),
      ),
      checkMeltQuote: mock(() =>
        Promise.resolve({
          state: 'PAID' as const,
          change: [],
        }),
      ),
      checkMeltQuoteState: mock(() => Promise.resolve('PAID' as const)),
      checkProofStates: mock(() => Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }])),
    } as unknown as MintAdapter;

    // Mock Logger
    logger = {
      debug: mock(() => { }),
      info: mock(() => { }),
      warn: mock(() => { }),
      error: mock(() => { }),
    } as Logger;
  });

  // ============================================================================
  // Context Builders
  // ============================================================================

  const buildPrepareContext = (
    operation: InitMeltOperation & MeltMethodMeta<'bolt11'>,
  ): BasePrepareContext<'bolt11'> => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildExecuteContext = (
    operation: ExecutingMeltOperation & MeltMethodMeta<'bolt11'>,
    reservedProofs: Proof[] = [],
  ): ExecuteContext<'bolt11'> => ({
    operation,
    wallet: mockWallet,
    reservedProofs,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildFinalizeContext = (
    operation: PendingMeltOperation & MeltMethodMeta<'bolt11'>,
  ): FinalizeContext<'bolt11'> => ({
    operation,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildPendingContext = (
    operation: PendingMeltOperation & MeltMethodMeta<'bolt11'>,
  ): PendingContext<'bolt11'> => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildRollbackContext = (
    operation: PreparedMeltOperation & MeltMethodMeta<'bolt11'>,
  ): RollbackContext<'bolt11'> => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildRecoverContext = (
    operation: ExecutingMeltOperation & MeltMethodMeta<'bolt11'>,
  ): RecoverExecutingContext<'bolt11'> => ({
    operation,
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  // ============================================================================
  // Prepare Phase Tests
  // ============================================================================

  describe('prepare', () => {
    describe('direct melt (no swap needed)', () => {
      it('should prepare a direct melt when proofs match amount', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        // Selected proofs are close to total amount (100 + 10 = 110)
        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() =>
          Promise.resolve([makeProof('input-1', 55), makeProof('input-2', 55)]),
        );

        const result = await handler.prepare(ctx);

        expect(result.state).toBe('prepared');
        expect(result.needsSwap).toBe(false);
        expect(result.quoteId).toBe('quote-123');
        expect(result.amount).toBe(100);
        expect(result.fee_reserve).toBe(10);
        expect(result.swap_fee).toBe(0);
        expect(result.inputProofSecrets).toEqual(['input-1', 'input-2']);
        expect(proofService.reserveProofs).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
          'op-1',
        );
      });

      it('should create blank outputs for change', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        // Selected amount (120) > quote amount (100), so change expected
        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() =>
          Promise.resolve([makeProof('input-1', 70), makeProof('input-2', 50)]),
        );

        await handler.prepare(ctx);

        // Change = 120 - 100 = 20
        expect(proofService.createBlankOutputs).toHaveBeenCalledWith(20, mintUrl);
      });
    });

    describe('swap-then-melt (excess proofs)', () => {
      it('should prepare swap when selected amount exceeds threshold', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        // Total required = 110, threshold = 110 * 1.1 = 121
        // First call returns proofs that exceed threshold (130 >= 121)
        // Second call (with fees) returns same
        let callCount = 0;
        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() => {
          callCount++;
          return Promise.resolve([makeProof('input-1', 80), makeProof('input-2', 50)]);
        });

        const result = await handler.prepare(ctx);

        expect(result.needsSwap).toBe(true);
        expect(result.swap_fee).toBe(1); // From mocked getFeesForProofs
        expect(result.swapOutputData).toBeDefined();
        expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalled();
      });

      it('should reserve proofs for swap operation', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() =>
          Promise.resolve([makeProof('input-1', 100), makeProof('input-2', 100)]),
        );

        await handler.prepare(ctx);

        expect(proofService.reserveProofs).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
          'op-1',
        );
      });
    });
  });

  // ============================================================================
  // Execute Phase Tests
  // ============================================================================

  describe('execute', () => {
    describe('direct melt execution', () => {
      it('should execute direct melt and return PAID result', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1', 'input-2'],
        });

        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(result.status).toBe('PAID');
        expect(proofService.setProofState).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
          'inflight',
        );
        expect(mintAdapter.customMeltBolt11).toHaveBeenCalled();
      });

      it('should handle PENDING response', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1'],
        });

        const inputProofs = [makeProof('input-1', 110)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );
        (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PENDING' }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(result.status).toBe('PENDING');
        if (result.status === 'PENDING') {
          expect(result.pending.state).toBe('pending');
        }
      });

      it('should restore proofs on UNPAID response', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1', 'input-2'],
        });

        const inputProofs = [makeProof('input-1', 60), makeProof('input-2', 50)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );
        (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'UNPAID' }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, [
          'input-1',
          'input-2',
        ]);
      });
    });

    describe('swap-then-melt execution', () => {
      it('should execute swap before melt', async () => {
        const swapOutputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        const inputProofs = [makeProof('input-1', 200)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        // Verify send was called
        expect(mockWallet.send).toHaveBeenCalled();

        // Verify input proofs were set to inflight before swap
        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'inflight');

        // Verify input proofs were set to spent after swap
        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');

        // Verify swap proofs were saved
        expect(proofService.saveProofs).toHaveBeenCalled();
      });

      it('should use swap send proofs for melt', async () => {
        const swapOutputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        const inputProofs = [makeProof('input-1', 200)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );

        // Capture what proofs are sent to melt
        let meltProofs: Proof[] = [];
        (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(
          (_mintUrl: string, proofs: Proof[]) => {
            meltProofs = proofs;
            return Promise.resolve({ state: 'PAID', change: [] });
          },
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        // Melt should receive swap send proofs (from mock wallet.swap)
        expect(meltProofs).toHaveLength(1);
        expect(meltProofs[0]!.secret).toBe('send-1');
      });

      it('should throw if swap output data is missing', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData: undefined,
        });

        const inputProofs = [makeProof('input-1', 200)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );

        const ctx = buildExecuteContext(operation, inputProofs);

        await expect(handler.execute(ctx)).rejects.toThrow(
          'Swap is required, but swap output data is missing',
        );
      });
    });

    describe('change handling', () => {
      it('should save change proofs on PAID response', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1'],
        });

        const inputProofs = [makeProof('input-1', 110)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );

        const changeSignatures: SerializedBlindedSignature[] = [
          { id: keysetId, amount: 10, C_: 'C_change' },
        ];
        (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PAID', change: changeSignatures }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        await handler.execute(ctx);

        expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
      });
    });
  });

  // ============================================================================
  // Finalize Phase Tests
  // ============================================================================

  describe('finalize', () => {
    it('should finalize a pending operation by fetching change', async () => {
      const operation = makePendingOp('op-1', {
        needsSwap: false,
        inputProofSecrets: ['input-1'],
      });

      const changeSignatures: SerializedBlindedSignature[] = [
        { id: keysetId, amount: 5, C_: 'C_change' },
      ];
      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: changeSignatures }),
      );

      const ctx = buildFinalizeContext(operation);
      await handler.finalize(ctx);

      expect(mintAdapter.checkMeltQuote).toHaveBeenCalledWith(mintUrl, 'quote-123');
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
    });

    it('should throw if quote is not PAID', async () => {
      const operation = makePendingOp('op-1');
      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PENDING' }),
      );

      const ctx = buildFinalizeContext(operation);

      await expect(handler.finalize(ctx)).rejects.toThrow(
        'Cannot finalize: melt quote quote-123 is PENDING, expected PAID',
      );
    });

    it('should mark swap send proofs as spent for swap-then-melt', async () => {
      const swapOutputData = createMockOutputData(['keep-1'], ['send-1']);
      const operation = makePendingOp('op-1', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        swapOutputData,
      });

      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: [] }),
      );

      const ctx = buildFinalizeContext(operation);
      await handler.finalize(ctx);

      // Should mark swap send proofs as spent (derived from swapOutputData)
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['send-1'], 'spent');
    });
  });

  // ============================================================================
  // CheckPending Tests
  // ============================================================================

  describe('checkPending', () => {
    it('should return finalize when quote is PAID', async () => {
      const operation = makePendingOp('op-1');
      (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
        Promise.resolve('PAID'),
      );

      const ctx = buildPendingContext(operation);
      const result = await handler.checkPending(ctx);

      expect(result).toBe('finalize');
    });

    it('should return stay_pending when quote is PENDING', async () => {
      const operation = makePendingOp('op-1');
      (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
        Promise.resolve('PENDING'),
      );

      const ctx = buildPendingContext(operation);
      const result = await handler.checkPending(ctx);

      expect(result).toBe('stay_pending');
    });

    it('should return rollback when quote is UNPAID', async () => {
      const operation = makePendingOp('op-1');
      (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
        Promise.resolve('UNPAID'),
      );

      const ctx = buildPendingContext(operation);
      const result = await handler.checkPending(ctx);

      expect(result).toBe('rollback');
    });

    it('should throw on unexpected state', async () => {
      const operation = makePendingOp('op-1');
      (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
        Promise.resolve('UNKNOWN'),
      );

      const ctx = buildPendingContext(operation);

      await expect(handler.checkPending(ctx)).rejects.toThrow(
        'Unexpected melt quote state: UNKNOWN for quote quote-123',
      );
    });
  });

  // ============================================================================
  // Rollback Tests
  // ============================================================================

  describe('rollback', () => {
    it('should restore proofs to ready for direct melt', async () => {
      const operation = makePreparedOp('op-1', {
        needsSwap: false,
        inputProofSecrets: ['input-1', 'input-2'],
      });

      const ctx = buildRollbackContext(operation);
      await handler.rollback(ctx);

      expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, [
        'input-1',
        'input-2',
      ]);
    });

    it('should restore swap send proofs for swap-then-melt', async () => {
      const swapOutputData = createMockOutputData(['keep-1'], ['send-1', 'send-2']);
      const operation = makePreparedOp('op-1', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        swapOutputData,
      });

      const ctx = buildRollbackContext(operation);
      await handler.rollback(ctx);

      // Should restore swap send proofs (not original inputs)
      expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, ['send-1', 'send-2']);
    });
  });

  // ============================================================================
  // Recovery Tests
  // ============================================================================

  describe('recoverExecuting', () => {
    describe('PAID recovery', () => {
      it('should finalize operation when quote is PAID', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1'],
        });

        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('PAID'),
        );
        (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PAID', change: [] }),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PAID');
        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      });

      it('should save change proofs when recovering PAID operation', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1'],
        });

        const changeSignatures: SerializedBlindedSignature[] = [
          { id: keysetId, amount: 5, C_: 'C_change' },
        ];
        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('PAID'),
        );
        (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PAID', change: changeSignatures }),
        );

        const ctx = buildRecoverContext(operation);
        await handler.recoverExecuting(ctx);

        expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
      });
    });

    describe('PENDING recovery', () => {
      it('should return pending result when quote is PENDING', async () => {
        const operation = makeExecutingOp('op-1');
        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('PENDING'),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PENDING');
      });
    });

    describe('UNPAID recovery - no swap', () => {
      it('should release proofs when no swap was needed', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1', 'input-2'],
        });

        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('UNPAID'),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1', 'input-2']);
      });
    });

    describe('UNPAID recovery - swap needed but not executed', () => {
      it('should release proofs when swap was never executed', async () => {
        const swapOutputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('UNPAID'),
        );
        // Input proofs are UNSPENT = swap never happened
        (mintAdapter.checkProofStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1']);
      });
    });

    describe('UNPAID recovery - swap executed, proofs saved locally', () => {
      it('should restore swap send proofs to ready', async () => {
        const swapOutputData = createMockOutputData(['keep-1'], ['send-1', 'send-2']);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        // Input proofs are SPENT = swap happened
        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('UNPAID'),
        );
        (mintAdapter.checkProofStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );

        // Swap send proofs exist locally
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve([
            makeCoreProof('send-1', 60, { createdByOperationId: 'op-1' }),
            makeCoreProof('send-2', 50, { createdByOperationId: 'op-1' }),
          ]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, [
          'send-1',
          'send-2',
        ]);
      });
    });

    describe('UNPAID recovery - swap executed, proofs NOT saved locally', () => {
      it('should recover proofs from mint', async () => {
        const swapOutputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        // Input proofs are SPENT = swap happened
        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('UNPAID'),
        );
        (mintAdapter.checkProofStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );

        // NO proofs exist locally (crash before save)
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve([]),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledWith(
          mintUrl,
          swapOutputData,
        );
        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      });

      it('should handle failure to mark input proofs as spent gracefully', async () => {
        const swapOutputData = createMockOutputData(['keep-1'], ['send-1']);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('UNPAID'),
        );
        (mintAdapter.checkProofStates as Mock<any>).mockImplementation(() =>
          Promise.resolve([{ state: 'SPENT', Y: 'y1' }]),
        );
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve([]),
        );

        // setProofState fails
        (proofService.setProofState as Mock<any>).mockImplementation(() =>
          Promise.reject(new Error('DB error')),
        );

        const ctx = buildRecoverContext(operation);
        // Should not throw, just log warning
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(logger.warn).toHaveBeenCalledWith('Failed to mark input proofs as spent', {
          operationId: 'op-1',
        });
      });
    });

    describe('unexpected state handling', () => {
      it('should throw on unexpected melt state', async () => {
        const operation = makeExecutingOp('op-1');
        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('INVALID'),
        );

        const ctx = buildRecoverContext(operation);

        await expect(handler.recoverExecuting(ctx)).rejects.toThrow(
          'Unexpected melt response state: INVALID for quote quote-123',
        );
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should throw if input proofs count does not match', async () => {
      const operation = makeExecutingOp('op-1', {
        inputProofSecrets: ['input-1', 'input-2', 'input-3'],
      });

      // Only return 2 proofs when 3 are expected
      (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
        Promise.resolve([makeProof('input-1'), makeProof('input-2')]),
      );

      const ctx = buildExecuteContext(operation);

      await expect(handler.execute(ctx)).rejects.toThrow('Could not find all input proofs');
    });

    it('should handle empty change gracefully', async () => {
      const operation = makeExecutingOp('op-1', {
        needsSwap: false,
        inputProofSecrets: ['input-1'],
      });

      const inputProofs = [makeProof('input-1', 110)];
      (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
        Promise.resolve(inputProofs),
      );
      (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: [] }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PAID');
      // Should not call unblindAndSaveChangeProofs with empty change
      expect(proofService.unblindAndSaveChangeProofs).not.toHaveBeenCalled();
    });

    it('should handle undefined change gracefully', async () => {
      const operation = makeExecutingOp('op-1', {
        needsSwap: false,
        inputProofSecrets: ['input-1'],
      });

      const inputProofs = [makeProof('input-1', 110)];
      (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
        Promise.resolve(inputProofs),
      );
      (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: undefined }),
      );

      const ctx = buildExecuteContext(operation, inputProofs);
      const result = await handler.execute(ctx);

      expect(result.status).toBe('PAID');
      expect(proofService.unblindAndSaveChangeProofs).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Constants Tests
  // ============================================================================

  describe('constants', () => {
    it('should use correct SWAP_THRESHOLD_RATIO', () => {
      expect(SWAP_THRESHOLD_RATIO).toBe(1.1);
    });
  });
});
