import { Amount } from '@cashu/cashu-ts';
import type { Proof, SerializedBlindedSignature, Wallet } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MeltBolt11Handler } from '../../infra/handlers/melt/MeltBolt11Handler';
import {
  SWAP_THRESHOLD_DENOMINATOR,
  SWAP_THRESHOLD_NUMERATOR,
} from '../../infra/handlers/melt/QuoteMeltHandler.utils';
import type { Logger } from '../../logging/Logger';
import { MintOperationError, ProofValidationError } from '../../models/Error';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote';
import type {
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
  FinalizeContext,
  MeltMethodMeta,
  PendingContext,
  RecoverExecutingContext,
  FetchRemoteMeltQuoteContext,
  RollbackContext,
} from '../../operations/melt/MeltMethodHandler';
import type {
  ExecutingMeltOperation,
  InitMeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
} from '../../operations/melt/MeltOperation';
import type { ProofRepository } from '../../repositories';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { CoreProof } from '../../types';

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
  type QuoteSnapshot = BasePrepareContext<'bolt11'>['quote'];

  // ============================================================================
  // Test Helpers
  // ============================================================================

  const makeProof = (secret: string, amount = 10, overrides?: Partial<Proof>): Proof =>
    ({
      amount: Amount.from(amount),
      C: `C_${secret}`,
      id: keysetId,
      secret,
      ...overrides,
    }) as Proof;

  const makeCoreProof = (secret: string, amount = 10, overrides?: Partial<CoreProof>): CoreProof =>
    ({
      amount: Amount.from(amount),
      C: `C_${secret}`,
      id: keysetId,
      secret,
      mintUrl,
      unit: 'sat',
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

  const createSwapOutputDataWithAmounts = (keepAmount: number, sendAmount: number) => ({
    keep: [
      {
        blindedMessage: { amount: keepAmount, id: keysetId, B_: 'B_keep_amount' },
        blindingFactor: '1234567890abcdef',
        secret: Buffer.from('keep-amount').toString('hex'),
      },
    ],
    send: [
      {
        blindedMessage: { amount: sendAmount, id: keysetId, B_: 'B_send_amount' },
        blindingFactor: 'abcdef1234567890',
        secret: Buffer.from('send-amount').toString('hex'),
      },
    ],
  });

  const makeInitOp = (
    id: string,
    overrides?: Partial<InitMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): InitMeltOperation & MeltMethodMeta<'bolt11'> => ({
    id,
    state: 'init',
    mintUrl,
    method: 'bolt11',
    methodData: { invoice },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makePreparedOp = (
    id: string,
    overrides?: Partial<PreparedMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): PreparedMeltOperation & MeltMethodMeta<'bolt11'> => ({
    id,
    state: 'prepared',
    mintUrl,
    method: 'bolt11',
    methodData: { invoice },
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    quoteId: 'quote-123',
    amount: Amount.from(100),
    fee_reserve: Amount.from(10),
    swap_fee: Amount.from(0),
    needsSwap: false,
    inputAmount: Amount.from(110),
    inputProofSecrets: ['input-1', 'input-2'],
    changeOutputData: createMockOutputData(['change-1'], []),
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makeQuoteSnapshot = (overrides?: Partial<QuoteSnapshot>): QuoteSnapshot => ({
    quote: overrides?.quote ?? 'quote-123',
    request: invoice,
    amount: overrides?.amount ?? Amount.from(100),
    unit: overrides?.unit ?? 'sat',
    fee_reserve: overrides?.fee_reserve ?? Amount.from(10),
    expiry: overrides?.expiry ?? Date.now() + 60000,
    state: overrides?.state ?? ('UNPAID' as const),
    payment_preimage: overrides?.payment_preimage ?? null,
  });

  const makeExecutingOp = (
    id: string,
    overrides?: Partial<ExecutingMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): ExecutingMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makePreparedOp(id),
    state: 'executing',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  const makePendingOp = (
    id: string,
    overrides?: Partial<PendingMeltOperation & MeltMethodMeta<'bolt11'>>,
  ): PendingMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makePreparedOp(id),
    state: 'pending',
    ...overrides,
    unit: overrides?.unit ?? 'sat',
  });

  // ============================================================================
  // Setup
  // ============================================================================

  beforeEach(() => {
    handler = new MeltBolt11Handler();
    eventBus = new EventBus<CoreEvents>();

    // Mock wallet
    mockWallet = {
      createMeltQuoteBolt11: mock(() =>
        Promise.resolve({
          quote: 'quote-123',
          request: invoice,
          amount: Amount.from(100),
          fee_reserve: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID' as const,
          payment_preimage: null,
        }),
      ),
      getFeesForProofs: mock(() => Amount.from(1)),
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
      reserveProofs: mock(() => Promise.resolve({ amount: Amount.from(110) })),
      createBlankOutputs: mock(() => Promise.resolve([])),
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: [],
          send: [],
          sendAmount: Amount.zero(),
          keepAmount: Amount.zero(),
        }),
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
          payment_preimage: 'preimage-123',
        }),
      ),
      checkMeltQuote: mock(() =>
        Promise.resolve({
          quote: 'quote-123',
          request: invoice,
          amount: Amount.from(100),
          unit: 'sat',
          fee_reserve: Amount.from(10),
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'PAID' as const,
          change: [],
          payment_preimage: 'preimage-123',
        }),
      ),
      checkMeltQuoteState: mock(() => Promise.resolve('PAID' as const)),
      checkProofStates: mock(() => Promise.resolve([{ state: 'UNSPENT', Y: 'y1' }])),
    } as unknown as MintAdapter;

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
    operation: InitMeltOperation & MeltMethodMeta<'bolt11'>,
    quote?: Partial<QuoteSnapshot>,
  ): BasePrepareContext<'bolt11'> => ({
    operation,
    quote: makeQuoteSnapshot(quote),
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildCreateQuoteContext = (
    methodData: { invoice: string; amountSats?: Amount } = { invoice },
  ): CreateMeltQuoteContext<'bolt11'> => ({
    mintUrl,
    methodData,
    unit: 'sat',
    wallet: mockWallet,
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  });

  const buildFetchRemoteQuoteContext = (): FetchRemoteMeltQuoteContext<'bolt11'> => ({
    quote: {
      mintUrl,
      method: 'bolt11',
      quoteId: 'quote-123',
      quote: 'quote-123',
      request: invoice,
      amount: Amount.from(100),
      unit: 'sat',
      fee_reserve: Amount.from(10),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID',
      payment_preimage: null,
      lastObservedRemoteState: 'UNPAID',
      lastObservedRemoteStateAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
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
  // Quote Tests
  // ============================================================================

  describe('quotes', () => {
    it('creates amountless BOLT11 melt quotes through the wallet', async () => {
      const quote = await handler.createQuote(buildCreateQuoteContext());

      expect(mockWallet.createMeltQuoteBolt11).toHaveBeenCalledWith(invoice, undefined);
      expect(quote.quoteId).toBe('quote-123');
      expect(quote.method).toBe('bolt11');
    });

    it('converts BOLT11 melt quote amounts from sats to millisats', async () => {
      await handler.createQuote(
        buildCreateQuoteContext({ invoice, amountSats: Amount.from(1000) }),
      );

      expect(mockWallet.createMeltQuoteBolt11).toHaveBeenCalledWith(
        invoice,
        Amount.from(1_000_000),
      );
    });

    it('fetches remote BOLT11 melt quotes through the mint adapter', async () => {
      const quote = await handler.fetchRemoteQuote(buildFetchRemoteQuoteContext());

      expect(mintAdapter.checkMeltQuote).toHaveBeenCalledWith(mintUrl, 'quote-123');
      expect(quote.quoteId).toBe('quote-123');
      expect(quote.method).toBe('bolt11');
    });
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
        expect(result.amount).toEqual(Amount.from(100));
        expect(result.fee_reserve).toEqual(Amount.from(10));
        expect(result.swap_fee).toEqual(Amount.from(0));
        expect(result.inputProofSecrets).toEqual(['input-1', 'input-2']);
        expect(proofService.reserveProofs).toHaveBeenCalledWith(
          mintUrl,
          ['input-1', 'input-2'],
          'op-1',
          { unit: 'sat' },
        );
        expect(proofService.selectProofsToSend).toHaveBeenCalledWith(
          mintUrl,
          { amount: Amount.from(110), unit: 'sat' },
          true,
        );
      });

      it('should select enough proofs to cover melt input fees', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        (proofService.selectProofsToSend as Mock<any>).mockImplementation(
          (_mintUrl: string, _amount: number, includeFees: boolean) => {
            return Promise.resolve(
              includeFees
                ? [makeProof('input-1', 60), makeProof('input-2', 50), makeProof('input-3', 1)]
                : [makeProof('input-1', 60), makeProof('input-2', 50)],
            );
          },
        );

        const result = await handler.prepare(ctx);

        expect(result.needsSwap).toBe(false);
        expect(result.inputAmount).toEqual(Amount.from(111));
        expect(result.inputProofSecrets).toEqual(['input-1', 'input-2', 'input-3']);
        expect(proofService.selectProofsToSend).toHaveBeenCalledWith(
          mintUrl,
          { amount: Amount.from(110), unit: 'sat' },
          true,
        );
      });

      it('should throw ProofValidationError when selected proofs do not cover fees', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() =>
          Promise.resolve([makeProof('input-1', 60), makeProof('input-2', 49)]),
        );

        await expect(handler.prepare(ctx)).rejects.toThrow(ProofValidationError);
        await expect(handler.prepare(ctx)).rejects.toThrow(
          'Melt amount is not sufficient after fees',
        );
        expect(proofService.reserveProofs).not.toHaveBeenCalled();
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
        expect(proofService.createBlankOutputs).toHaveBeenCalledWith(mintUrl, {
          amount: Amount.from(20),
          unit: 'sat',
        });
      });

      it('prepares custom-unit direct melts with unit-scoped selection and change outputs', async () => {
        const operation = makeInitOp('op-usd', { unit: 'usd' });
        const ctx = buildPrepareContext(operation, {
          quote: 'quote-usd',
          unit: 'USD',
        });
        (proofService.selectProofsToSend as Mock<any>).mockResolvedValueOnce([
          makeProof('usd-input-1', 60),
          makeProof('usd-input-2', 60),
        ]);

        const result = await handler.prepare(ctx);

        expect(result.unit).toBe('usd');
        expect(result.quoteId).toBe('quote-usd');
        expect(proofService.selectProofsToSend).toHaveBeenCalledWith(
          mintUrl,
          { amount: Amount.from(110), unit: 'usd' },
          true,
        );
        expect(proofService.reserveProofs).toHaveBeenCalledWith(
          mintUrl,
          ['usd-input-1', 'usd-input-2'],
          'op-usd',
          { unit: 'usd' },
        );
        expect(proofService.createBlankOutputs).toHaveBeenCalledWith(mintUrl, {
          amount: Amount.from(20),
          unit: 'usd',
        });
      });

      it('rejects melt quote unit mismatches before selecting proofs', async () => {
        const operation = makeInitOp('op-usd', { unit: 'usd' });
        const ctx = buildPrepareContext(operation, {
          quote: 'quote-sat',
          unit: 'sat',
        });

        await expect(handler.prepare(ctx)).rejects.toThrow('Unit mismatch');
        expect(proofService.selectProofsToSend).not.toHaveBeenCalled();
      });

      it('uses the pre-created canonical quote without creating a remote quote', async () => {
        const operation = makeInitOp('op-1', {
          methodData: { invoice, amountSats: Amount.from(1000) },
        });
        const ctx = buildPrepareContext(operation);

        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() =>
          Promise.resolve([makeProof('input-1', 55), makeProof('input-2', 55)]),
        );

        await handler.prepare(ctx);

        expect(mockWallet.createMeltQuoteBolt11).not.toHaveBeenCalled();
      });
    });

    describe('swap-then-melt (excess proofs)', () => {
      it('should prepare swap when selected amount exceeds threshold', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        // Total required = 110, threshold = 110 * 1.1 = 121
        // Both fee-aware selections return proofs that exceed threshold (130 >= 121)
        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() => {
          return Promise.resolve([makeProof('input-1', 80), makeProof('input-2', 50)]);
        });

        const result = await handler.prepare(ctx);

        expect(result.needsSwap).toBe(true);
        expect(result.swap_fee).toEqual(Amount.from(1)); // From mocked getFeesForProofs
        expect(result.swapOutputData).toBeDefined();
        expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalled();
        expect((proofService.selectProofsToSend as Mock<any>).mock.calls[0]).toEqual([
          mintUrl,
          { amount: Amount.from(110), unit: 'sat' },
          true,
        ]);
        expect((proofService.selectProofsToSend as Mock<any>).mock.calls[1]).toEqual([
          mintUrl,
          { amount: Amount.from(110), unit: 'sat' },
          true,
        ]);
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
          { unit: 'sat' },
        );
      });

      it('should throw ProofValidationError when swap proofs do not cover input fees', async () => {
        const operation = makeInitOp('op-1');
        const ctx = buildPrepareContext(operation);

        (mockWallet.getFeesForProofs as Mock<any>).mockImplementation(() => Amount.from(25));
        (proofService.selectProofsToSend as Mock<any>).mockImplementation(() =>
          Promise.resolve([makeProof('input-1', 80), makeProof('input-2', 50)]),
        );

        await expect(handler.prepare(ctx)).rejects.toThrow(ProofValidationError);
        await expect(handler.prepare(ctx)).rejects.toThrow(
          'Melt amount is not sufficient after fees',
        );
        expect(proofService.reserveProofs).not.toHaveBeenCalled();
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
        if (result.status === 'PAID') {
          expect(result.finalized.changeAmount).toEqual(Amount.from(0));
          expect(result.finalized.effectiveFee).toEqual(Amount.from(10));
          expect(result.finalized.finalizedData?.preimage).toBe('preimage-123');
        }
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
        const swapOutputData = createSwapOutputDataWithAmounts(90, 110);
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
        const swapOutputData = createSwapOutputDataWithAmounts(90, 110);
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

      it('should calculate effectiveFee from swapped melt inputs only', async () => {
        const swapOutputData = createSwapOutputDataWithAmounts(140, 60);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          amount: Amount.from(55),
          inputAmount: Amount.from(200),
          inputProofSecrets: ['input-1'],
          swapOutputData,
        });

        const inputProofs = [makeProof('input-1', 200)];
        (proofRepository.getProofsByOperationId as Mock<any>).mockImplementation(() =>
          Promise.resolve(inputProofs),
        );
        (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PAID', change: [] }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(result.status).toBe('PAID');
        if (result.status === 'PAID') {
          expect(result.finalized.changeAmount).toEqual(Amount.from(0));
          expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
        }
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
          { id: keysetId, amount: Amount.from(10), C_: 'C_change' },
        ];
        (mintAdapter.customMeltBolt11 as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PAID', change: changeSignatures }),
        );

        const ctx = buildExecuteContext(operation, inputProofs);
        const result = await handler.execute(ctx);

        expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
        expect(result.status).toBe('PAID');
        if (result.status === 'PAID') {
          expect(result.finalized.changeAmount).toEqual(Amount.from(10));
          expect(result.finalized.effectiveFee).toEqual(Amount.from(0));
        }
      });
    });
  });

  // ============================================================================
  // Finalize Phase Tests
  // ============================================================================

  describe('finalize', () => {
    it('should finalize a pending operation from persisted canonical settlement fields', async () => {
      const operation = makePendingOp('op-canonical-finalize', {
        needsSwap: false,
        inputProofSecrets: ['input-1'],
      });
      const changeSignatures: SerializedBlindedSignature[] = [
        { id: keysetId, amount: Amount.from(5), C_: 'C_change' },
      ];
      const quote = meltQuoteFromBolt11Response(mintUrl, {
        quote: operation.quoteId,
        request: invoice,
        amount: operation.amount,
        unit: operation.unit,
        fee_reserve: operation.fee_reserve,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
        payment_preimage: 'preimage-canonical',
        change: changeSignatures,
      });

      const result = await handler.finalize({
        ...buildFinalizeContext(operation),
        canonicalQuote: quote,
      });

      expect(mintAdapter.checkMeltQuote).not.toHaveBeenCalled();
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(5),
        effectiveFee: Amount.from(5),
        finalizedData: { preimage: 'preimage-canonical' },
      });
    });

    it('should finalize a pending operation by fetching change', async () => {
      const operation = makePendingOp('op-1', {
        needsSwap: false,
        inputProofSecrets: ['input-1'],
      });

      const changeSignatures: SerializedBlindedSignature[] = [
        { id: keysetId, amount: Amount.from(5), C_: 'C_change' },
      ];
      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({
          state: 'PAID',
          change: changeSignatures,
          payment_preimage: 'preimage-123',
        }),
      );

      const ctx = buildFinalizeContext(operation);
      const result = await handler.finalize(ctx);

      expect(mintAdapter.checkMeltQuote).toHaveBeenCalledWith(mintUrl, 'quote-123');
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(5),
        effectiveFee: Amount.from(5),
        finalizedData: { preimage: 'preimage-123' },
      });
    });

    it('should fetch full settlement when a PAID canonical quote omits change', async () => {
      const operation = makePendingOp('op-partial-canonical', {
        needsSwap: false,
        inputProofSecrets: ['input-1'],
      });
      const changeSignatures: SerializedBlindedSignature[] = [
        { id: keysetId, amount: Amount.from(5), C_: 'C_change' },
      ];
      const quote = meltQuoteFromBolt11Response(mintUrl, {
        quote: operation.quoteId,
        request: invoice,
        amount: operation.amount,
        unit: operation.unit,
        fee_reserve: operation.fee_reserve,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PAID',
        payment_preimage: 'preimage-partial',
      });
      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({
          state: 'PAID',
          change: changeSignatures,
          payment_preimage: 'preimage-remote',
        }),
      );

      const result = await handler.finalize({
        ...buildFinalizeContext(operation),
        canonicalQuote: quote,
      });

      expect(mintAdapter.checkMeltQuote).toHaveBeenCalledWith(mintUrl, operation.quoteId);
      expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(5),
        effectiveFee: Amount.from(5),
        finalizedData: { preimage: 'preimage-remote' },
      });
    });

    it('should not re-check the mint when a supplied canonical quote is not PAID', async () => {
      const operation = makePendingOp('op-canonical-pending');
      const quote = meltQuoteFromBolt11Response(mintUrl, {
        quote: operation.quoteId,
        request: invoice,
        amount: operation.amount,
        unit: operation.unit,
        fee_reserve: operation.fee_reserve,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        state: 'PENDING',
        payment_preimage: null,
      });
      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: [], payment_preimage: 'preimage-remote' }),
      );

      await expect(
        handler.finalize({
          ...buildFinalizeContext(operation),
          canonicalQuote: quote,
        }),
      ).rejects.toThrow('Cannot finalize: melt quote quote-123 is PENDING, expected PAID');
      expect(mintAdapter.checkMeltQuote).not.toHaveBeenCalled();
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
      const swapOutputData = createSwapOutputDataWithAmounts(90, 110);
      const operation = makePendingOp('op-1', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        swapOutputData,
      });

      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: [], payment_preimage: 'preimage-123' }),
      );

      const ctx = buildFinalizeContext(operation);
      await handler.finalize(ctx);

      // Should mark swap send proofs as spent (derived from swapOutputData)
      expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['send-amount'], 'spent');
    });

    it('should calculate finalize effectiveFee from swapped melt inputs only', async () => {
      const swapOutputData = createSwapOutputDataWithAmounts(140, 60);
      const operation = makePendingOp('op-1', {
        needsSwap: true,
        amount: Amount.from(55),
        inputAmount: Amount.from(200),
        inputProofSecrets: ['input-1'],
        swapOutputData,
      });

      (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
        Promise.resolve({ state: 'PAID', change: [] }),
      );

      const ctx = buildFinalizeContext(operation);
      const result = await handler.finalize(ctx);

      expect(result).toEqual({
        changeAmount: Amount.from(0),
        effectiveFee: Amount.from(5),
        finalizedData: undefined,
      });
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

    it('should restore swap send proofs and release original inputs for swap-then-melt', async () => {
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
      expect(proofService.releaseProofs).toHaveBeenCalledWith(mintUrl, ['input-1']);
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
          Promise.resolve({
            state: 'PAID',
            change: [],
            payment_preimage: 'preimage-123',
          }),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('PAID');
        if (result.status === 'PAID') {
          expect(result.finalized.changeAmount).toEqual(Amount.from(0));
          expect(result.finalized.effectiveFee).toEqual(Amount.from(10));
          expect(result.finalized.finalizedData?.preimage).toBe('preimage-123');
        }
        expect(proofService.setProofState).toHaveBeenCalledWith(mintUrl, ['input-1'], 'spent');
      });

      it('should save change proofs when recovering PAID operation', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1'],
        });

        const changeSignatures: SerializedBlindedSignature[] = [
          { id: keysetId, amount: Amount.from(5), C_: 'C_change' },
        ];
        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() =>
          Promise.resolve('PAID'),
        );
        (mintAdapter.checkMeltQuote as Mock<any>).mockImplementation(() =>
          Promise.resolve({ state: 'PAID', change: changeSignatures }),
        );

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(proofService.unblindAndSaveChangeProofs).toHaveBeenCalled();
        expect(result.status).toBe('PAID');
        if (result.status === 'PAID') {
          expect(result.finalized.changeAmount).toEqual(Amount.from(5));
          expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
        }
      });

      it('should calculate recovery effectiveFee from swapped melt inputs only', async () => {
        const swapOutputData = createSwapOutputDataWithAmounts(140, 60);
        const operation = makeExecutingOp('op-1', {
          needsSwap: true,
          amount: Amount.from(55),
          inputAmount: Amount.from(200),
          inputProofSecrets: ['input-1'],
          swapOutputData,
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
        if (result.status === 'PAID') {
          expect(result.finalized.changeAmount).toEqual(Amount.from(0));
          expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
        }
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
        expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, [
          'input-1',
          'input-2',
        ]);
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
        expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, ['input-1']);
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
          {
            unit: 'sat',
            createdByOperationId: 'op-1',
          },
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

    describe('quote expired recovery (20007)', () => {
      it('should treat expired quote as UNPAID and release proofs (no swap)', async () => {
        const operation = makeExecutingOp('op-1', {
          needsSwap: false,
          inputProofSecrets: ['input-1', 'input-2'],
        });

        (mintAdapter.checkMeltQuoteState as Mock<any>).mockImplementation(() => {
          throw new MintOperationError(20007, 'Quote expired');
        });

        const ctx = buildRecoverContext(operation);
        const result = await handler.recoverExecuting(ctx);

        expect(result.status).toBe('FAILED');
        expect(proofService.restoreProofsToReady).toHaveBeenCalledWith(mintUrl, [
          'input-1',
          'input-2',
        ]);
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
    it('should use a 10% integer swap threshold', () => {
      expect(SWAP_THRESHOLD_NUMERATOR).toBe(11);
      expect(SWAP_THRESHOLD_DENOMINATOR).toBe(10);
    });
  });
});
