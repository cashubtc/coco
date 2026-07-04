import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { OutputData, type MintQuoteBolt11Response, type Wallet } from '@cashu/cashu-ts';
import { MintBolt11Handler } from '../../infra/handlers/mint/MintBolt11Handler';
import { MintOperationError } from '../../models/Error';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type {
  CreateMintQuoteContext,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
  FetchRemoteMintQuoteContext,
} from '../../operations/mint';
import { serializeOutputData } from '../../utils';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { MintService } from '../../services/MintService';
import type { MintAdapter } from '../../infra';
import type { ProofRepository } from '../../repositories';
import type { Logger } from '../../logging/Logger';

describe('MintBolt11Handler', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';
  const keysetId = 'keyset-1';

  let handler: MintBolt11Handler;
  let wallet: Wallet;
  let mintAdapter: MintAdapter;
  let proofService: ProofService;
  let proofRepository: ProofRepository;
  let walletService: WalletService;
  let mintService: MintService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;

  const outputData = serializeOutputData({
    keep: [
      new OutputData(
        {
          amount: Amount.from(10),
          id: keysetId,
          B_: 'B_out_1',
        },
        BigInt(1),
        new TextEncoder().encode('out-1'),
      ),
    ],
    send: [],
  });

  const operation = {
    id: 'op-1',
    state: 'init' as const,
    mintUrl,
    amount: Amount.from(10),
    unit: 'sat',
    method: 'bolt11' as const,
    methodData: {},
    quoteId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const quote: MintQuoteBolt11Response = {
    quote: quoteId,
    request: 'lnbc1test',
    method: 'bolt11',
    amount: Amount.from(10),
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    state: 'PAID',
    amount_paid: Amount.from(10),
    amount_issued: Amount.zero(),
    updated_at: null,
  };

  const executingOperation = {
    ...operation,
    state: 'executing' as const,
    quoteId,
    request: quote.request,
    expiry: quote.expiry,
    outputData,
  };

  const buildPrepareContext = (): PrepareContext<'bolt11'> => ({
    operation,
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildCreateQuoteContext = (): CreateMintQuoteContext<'bolt11'> => ({
    mintUrl,
    createQuoteData: { amount: { amount: Amount.from(10), unit: 'sat' } },
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildFetchRemoteQuoteContext = (): FetchRemoteMintQuoteContext<'bolt11'> => ({
    quote: {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: quoteId,
      request: quote.request,
      unit: quote.unit,
      amount: quote.amount,
      expiry: quote.expiry,
      state: quote.state,
      reusable: false,
      quoteData: {
        amount: quote.amount,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildRecoverContext = (): RecoverExecutingContext<'bolt11'> => ({
    operation: executingOperation,
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildPendingContext = (): PendingContext<'bolt11'> => ({
    operation: {
      ...executingOperation,
      state: 'pending',
    },
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  beforeEach(() => {
    handler = new MintBolt11Handler();

    wallet = {
      createMintQuoteBolt11: mock(async () => quote),
      mintProofsBolt11: mock(async () => {
        throw new MintOperationError(20007, 'Quote expired');
      }),
    } as unknown as Wallet;

    mintAdapter = {
      checkMintQuote: mock(async (): Promise<MintQuoteBolt11Response> => quote),
    } as unknown as MintAdapter;

    proofService = {
      createOutputsAndIncrementCounters: mock(async () => ({ keep: outputData.keep, send: [] })),
      saveProofs: mock(async () => {}),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;

    proofRepository = {} as ProofRepository;
    walletService = {} as WalletService;
    mintService = {} as MintService;
    eventBus = new EventBus<CoreEvents>();
    logger = { info: mock(() => {}) } as unknown as Logger;
  });

  describe('quotes', () => {
    it('creates a BOLT11 mint quote through the wallet', async () => {
      const result = await handler.createQuote(buildCreateQuoteContext());

      expect(wallet.createMintQuoteBolt11).toHaveBeenCalledWith(Amount.from(10));
      expect(result.quoteId).toBe(quoteId);
      expect(result.method).toBe('bolt11');
    });

    it('fetches a remote BOLT11 mint quote through the mint adapter', async () => {
      const result = await handler.fetchRemoteQuote(buildFetchRemoteQuoteContext());

      expect(mintAdapter.checkMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
      expect(result.quoteId).toBe(quoteId);
      expect(result.method).toBe('bolt11');
    });
  });

  describe('recoverExecuting', () => {
    it('returns a terminal result when the mint quote expired during execution', async () => {
      const result = await handler.recoverExecuting(buildRecoverContext());

      expect(result).toEqual({
        status: 'TERMINAL',
        error: `Recovered: quote ${quoteId} expired while executing mint`,
      });
      expect((wallet.mintProofsBolt11 as Mock<any>).mock.calls.length).toBe(1);
      expect((proofService.saveProofs as Mock<any>).mock.calls.length).toBe(0);
    });
  });

  describe('prepare', () => {
    it('requires the service to provide an existing quote snapshot', async () => {
      await expect(handler.prepare(buildPrepareContext())).rejects.toThrow(
        'Mint quote quote-1 was not provided',
      );
      expect((wallet.createMintQuoteBolt11 as Mock<any>).mock.calls).toHaveLength(0);
    });

    it('uses the imported quote snapshot without creating a new remote quote', async () => {
      const importedQuote = {
        ...quote,
        quote: 'quote-imported',
        state: 'UNPAID' as const,
      };

      const result = await handler.prepare({
        ...buildPrepareContext(),
        operation: { ...operation, quoteId: importedQuote.quote },
        importedQuote,
      });

      expect((wallet.createMintQuoteBolt11 as Mock<any>).mock.calls).toHaveLength(0);
      expect(result.quoteId).toBe(importedQuote.quote);
    });

    it('normalizes quote unit comparison and persists the operation unit', async () => {
      const usdOperation = { ...operation, unit: 'usd' };
      const usdQuote = { ...quote, unit: 'USD' };
      (wallet.createMintQuoteBolt11 as Mock<any>).mockImplementation(async () => usdQuote);

      const result = await handler.prepare({
        ...buildPrepareContext(),
        operation: usdOperation,
        importedQuote: usdQuote,
      });

      expect(result.unit).toBe('usd');
      expect(result.quoteId).toBe(quoteId);
    });
  });

  describe('checkPending', () => {
    it('returns the observed remote state with a normalized ready category', async () => {
      const result = await handler.checkPending(buildPendingContext());

      expect(result.observedRemoteState).toBe('PAID');
      expect(result.category).toBe('ready');
      expect(result.observedRemoteStateAt).toEqual(expect.any(Number));
    });
  });
});
