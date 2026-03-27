import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { OutputData, type MintQuoteBolt11Response, type Wallet } from '@cashu/cashu-ts';
import { MintBolt11Handler } from '../../infra/handlers/mint/MintBolt11Handler';
import { MintOperationError } from '../../models/Error';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type {
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
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
          amount: 10,
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
    amount: 10,
    unit: 'sat',
    method: 'bolt11' as const,
    methodData: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const quote: MintQuoteBolt11Response = {
    quote: quoteId,
    request: 'lnbc1test',
    amount: 10,
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    state: 'PAID',
  };

  const executingOperation = {
    ...operation,
    state: 'executing' as const,
    quoteId,
    request: quote.request,
    expiry: quote.expiry,
    lastObservedRemoteState: 'PAID' as const,
    lastObservedRemoteStateAt: Date.now(),
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
      checkMintQuoteState: mock(async (): Promise<MintQuoteBolt11Response> => quote),
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
    it('creates a remote quote when no imported quote is provided', async () => {
      const result = await handler.prepare(buildPrepareContext());

      expect((wallet.createMintQuoteBolt11 as Mock<any>).mock.calls).toHaveLength(1);
      expect(result.quoteId).toBe(quoteId);
      expect(result.amount).toBe(quote.amount);
      expect(result.request).toBe(quote.request);
      expect(result.outputData.keep).toHaveLength(1);
      expect(result.outputData.send).toEqual([]);
      expect(result.outputData.keep[0]?.blindedMessage).toEqual(outputData.keep[0]?.blindedMessage);
      expect(result.lastObservedRemoteState).toBe('PAID');
    });

    it('uses the imported quote snapshot without creating a new remote quote', async () => {
      const importedQuote = {
        ...quote,
        quote: 'quote-imported',
        state: 'UNPAID' as const,
      };

      const result = await handler.prepare({
        ...buildPrepareContext(),
        importedQuote,
      });

      expect((wallet.createMintQuoteBolt11 as Mock<any>).mock.calls).toHaveLength(0);
      expect(result.quoteId).toBe(importedQuote.quote);
      expect(result.lastObservedRemoteState).toBe('UNPAID');
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
