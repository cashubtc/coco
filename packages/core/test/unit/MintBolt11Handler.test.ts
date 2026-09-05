import { Amount, OutputData, type MintQuoteBolt11Response, type Wallet } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MintBolt11Handler } from '../../infra/handlers/mint/MintBolt11Handler';
import type { Logger } from '../../logging/Logger';
import {
  MintOperationError,
  MintQuoteKeyError,
  MintQuoteValidationError,
} from '../../models/Error';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  FetchRemoteMintQuoteContext,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
} from '../../operations/mint';
import type { ProofRepository } from '../../repositories';
import type { KeyRingService } from '../../services/KeyRingService';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import { serializeOutputData } from '../../utils';

describe('MintBolt11Handler', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';
  const keysetId = 'keyset-1';
  const quotePubkey = `02${'11'.repeat(32)}`;
  const quoteSecretKey = new Uint8Array(32).fill(7);

  let handler: MintBolt11Handler;
  let wallet: Wallet;
  let mintAdapter: MintAdapter;
  let proofService: ProofService;
  let proofRepository: ProofRepository;
  let walletService: WalletService;
  let mintService: MintService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let keyRingService: KeyRingService;

  const outputData = serializeOutputData({
    keep: [
      new OutputData(
        {
          amount: Amount.from(6),
          id: keysetId,
          B_: 'B_out_1',
        },
        BigInt(1),
        new TextEncoder().encode('out-1'),
      ),
      new OutputData(
        {
          amount: Amount.from(4),
          id: keysetId,
          B_: 'B_out_2',
        },
        BigInt(2),
        new TextEncoder().encode('out-2'),
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
    amount_paid: Amount.from(10),
    amount_issued: Amount.zero(),
    updated_at: null,
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
      amountPaid: quote.state === 'UNPAID' ? Amount.zero() : quote.amount,
      amountIssued: quote.state === 'ISSUED' ? quote.amount : Amount.zero(),
      remoteUpdatedAt: quote.updated_at ?? null,
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
    localClaimabilityFacts: {
      finalizedAmount: Amount.zero(),
      reservedAmount: Amount.zero(),
    },
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildExecuteContext = (
    operationOverride: ExecuteContext<'bolt11'>['operation'] = executingOperation,
  ): ExecuteContext<'bolt11'> => ({
    operation: operationOverride,
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
    mintAdapter,
    logger,
  });

  beforeEach(() => {
    keyRingService = {
      generateMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: quotePubkey,
        secretKey: quoteSecretKey,
        purpose: 'nut20_mint_quote' as const,
      })),
      getMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: quotePubkey,
        secretKey: quoteSecretKey,
        purpose: 'nut20_mint_quote' as const,
      })),
    } as unknown as KeyRingService;
    handler = new MintBolt11Handler(keyRingService);

    wallet = {
      createMintQuoteBolt11: mock(async () => quote),
      createLockedMintQuote: mock(async () => ({ ...quote, pubkey: quotePubkey })),
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
    mintService = {
      assertNutSupported: mock(async () => {}),
    } as unknown as MintService;
    eventBus = new EventBus<CoreEvents>();
    logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
    } as unknown as Logger;
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

    it('creates an opt-in locked BOLT11 quote with a fresh persisted key', async () => {
      const result = await handler.createQuote({
        ...buildCreateQuoteContext(),
        createQuoteData: {
          amount: { amount: Amount.from(10), unit: 'sat' },
          locked: true,
        },
      });

      expect(mintService.assertNutSupported).toHaveBeenCalledWith(
        mintUrl,
        20,
        'locked BOLT11 mint quote',
      );
      expect(keyRingService.generateMintQuoteKeyPair).toHaveBeenCalledTimes(1);
      expect(wallet.createLockedMintQuote).toHaveBeenCalledWith(Amount.from(10), quotePubkey);
      expect(result.pubkey).toBe(quotePubkey);
      expect((wallet.createMintQuoteBolt11 as Mock<any>).mock.calls).toHaveLength(0);
    });

    it('rejects an owned locking key before remote creation when it is not persisted', async () => {
      (keyRingService.getMintQuoteKeyPair as Mock<any>).mockResolvedValueOnce(null);

      const error = await handler
        .createQuote({
          ...buildCreateQuoteContext(),
          createQuoteData: {
            amount: { amount: Amount.from(10), unit: 'sat' },
            ownedPubkey: quotePubkey,
          },
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(MintQuoteKeyError);
      expect(error.message).toContain('Missing NUT-20 mint quote key');

      expect(mintService.assertNutSupported).toHaveBeenCalledWith(
        mintUrl,
        20,
        'locked BOLT11 mint quote',
      );
      expect(wallet.createLockedMintQuote).not.toHaveBeenCalled();
    });

    it('rejects a locked quote whose returned public key does not match the persisted key', async () => {
      (wallet.createLockedMintQuote as Mock<any>).mockResolvedValueOnce({
        ...quote,
        pubkey: `03${'22'.repeat(32)}`,
      });

      const error = await handler
        .createQuote({
          ...buildCreateQuoteContext(),
          createQuoteData: {
            amount: { amount: Amount.from(10), unit: 'sat' },
            locked: true,
          },
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(MintQuoteValidationError);
      expect(error.message).toBe(
        'Mint returned a BOLT11 quote with an unexpected NUT-20 public key',
      );
    });
  });
});
