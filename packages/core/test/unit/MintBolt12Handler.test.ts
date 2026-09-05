import { Amount, OutputData, type MintQuoteBolt12Response, type Wallet } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MintBolt12Handler } from '../../infra/handlers/mint/MintBolt12Handler';
import type { Logger } from '../../logging/Logger';
import { MintQuoteValidationError } from '../../models/Error';
import { mintQuoteFromBolt12Response } from '../../models/MintQuote';
import type {
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

describe('MintBolt12Handler', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-12';
  const pubkey = '02' + '11'.repeat(32);
  const secretKey = new Uint8Array(32).fill(7);

  let handler: MintBolt12Handler;
  let wallet: Wallet;
  let mintAdapter: MintAdapter;
  let proofService: ProofService;
  let proofRepository: ProofRepository;
  let walletService: WalletService;
  let mintService: MintService;
  let keyRingService: KeyRingService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;

  const outputData = serializeOutputData({
    keep: [
      new OutputData(
        {
          amount: Amount.from(10),
          id: 'keyset-1',
          B_: 'B_out_1',
        },
        BigInt(1),
        new TextEncoder().encode('out-1'),
      ),
    ],
    send: [],
  });

  const operation = {
    id: 'op-12',
    state: 'init' as const,
    mintUrl,
    amount: Amount.from(10),
    unit: 'sat',
    method: 'bolt12' as const,
    methodData: {},
    quoteId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const quote = (overrides: Partial<MintQuoteBolt12Response> = {}): MintQuoteBolt12Response => ({
    quote: quoteId,
    request: 'lno1offer',
    method: 'bolt12',
    amount: Amount.from(10),
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    pubkey,
    amount_paid: Amount.zero(),
    amount_issued: Amount.zero(),
    updated_at: null,
    ...overrides,
  });

  const buildPrepareContext = (
    overrides: Partial<PrepareContext<'bolt12'>> = {},
  ): PrepareContext<'bolt12'> => ({
    operation,
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
    ...overrides,
  });

  const buildFetchRemoteQuoteContext = (): FetchRemoteMintQuoteContext<'bolt12'> => ({
    quote: mintQuoteFromBolt12Response(mintUrl, quote()),
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildPendingContext = (remoteQuote: MintQuoteBolt12Response): PendingContext<'bolt12'> => {
    (mintAdapter.checkMintQuote as Mock<any>).mockImplementation(async () => remoteQuote);
    return {
      operation: {
        ...operation,
        state: 'pending',
        quoteId,
        request: remoteQuote.request,
        expiry: remoteQuote.expiry,
        pubkey,
        outputData,
      },
      mintAdapter,
      logger,
    };
  };

  const buildExecuteContext = (remoteQuote: MintQuoteBolt12Response): ExecuteContext<'bolt12'> => {
    (mintAdapter.checkMintQuote as Mock<any>).mockImplementation(async () => remoteQuote);
    return {
      ...buildPrepareContext(),
      operation: {
        ...operation,
        state: 'executing',
        quoteId,
        request: remoteQuote.request,
        expiry: remoteQuote.expiry,
        pubkey,
        outputData,
      },
    };
  };

  const buildRecoverContext = (
    remoteQuote: MintQuoteBolt12Response,
    localClaimabilityFacts = {
      finalizedAmount: Amount.zero(),
      reservedAmount: Amount.zero(),
    },
  ): RecoverExecutingContext<'bolt12'> => ({
    ...buildExecuteContext(remoteQuote),
    localClaimabilityFacts,
  });

  beforeEach(() => {
    wallet = {
      createMintQuoteBolt12: mock(async () => quote()),
      mintProofsBolt12: mock(async () => []),
    } as unknown as Wallet;
    mintAdapter = {
      checkMintQuote: mock(async () => quote()),
    } as unknown as MintAdapter;
    proofService = {
      createOutputsAndIncrementCounters: mock(async () => ({ keep: outputData.keep, send: [] })),
      saveProofs: mock(async () => {}),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;
    keyRingService = {
      generateMintQuoteKeyPair: mock(async () => ({ publicKeyHex: pubkey, secretKey })),
      getMintQuoteKeyPair: mock(async () => ({ publicKeyHex: pubkey, secretKey })),
    } as unknown as KeyRingService;
    handler = new MintBolt12Handler(keyRingService);
    proofRepository = {} as ProofRepository;
    walletService = {} as WalletService;
    mintService = {} as MintService;
    eventBus = new EventBus<CoreEvents>();
    logger = { info: mock(() => {}), warn: mock(() => {}) } as unknown as Logger;
  });

  it('creates a fixed-amount quote with a fresh keypair', async () => {
    const result = await handler.createQuote({
      ...buildPrepareContext(),
      mintUrl,
      createQuoteData: {
        unit: 'sat',
        amount: { amount: Amount.from(10), unit: 'sat' },
      },
    });

    expect(keyRingService.generateMintQuoteKeyPair).toHaveBeenCalled();
    expect(wallet.createMintQuoteBolt12).toHaveBeenCalledWith(pubkey, {
      amount: Amount.from(10),
      description: undefined,
    });
    expect(result.quoteId).toBe(quoteId);
    expect(result.pubkey).toBe(pubkey);
    expect(result.reusable).toBe(true);
  });

  it('fetches the latest BOLT12 quote through the mint adapter', async () => {
    const remoteQuote = quote({
      amount_paid: Amount.from(21),
      amount_issued: Amount.from(8),
      updated_at: 20,
    });
    (mintAdapter.checkMintQuote as Mock<any>).mockImplementationOnce(async () => remoteQuote);

    const result = await handler.fetchRemoteQuote(buildFetchRemoteQuoteContext());

    expect(mintAdapter.checkMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt12', quoteId);
    expect(result.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(result.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(result.remoteUpdatedAt).toBe(20);
  });

  it('rejects fixed-amount quotes when the mint omits the response amount', async () => {
    (wallet.createMintQuoteBolt12 as Mock<any>).mockImplementation(async () =>
      quote({ amount: undefined }),
    );

    const error = await handler
      .createQuote({
        ...buildPrepareContext(),
        mintUrl,
        createQuoteData: {
          unit: 'sat',
          amount: { amount: Amount.from(10), unit: 'sat' },
        },
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(MintQuoteValidationError);
    expect(error.message).toContain('does not match requested amount');
  });

  it('rejects fixed-amount quotes when the mint returns a null response amount', async () => {
    (wallet.createMintQuoteBolt12 as Mock<any>).mockImplementation(async () =>
      quote({ amount: null as unknown as Amount }),
    );

    await expect(
      handler.createQuote({
        ...buildPrepareContext(),
        mintUrl,
        createQuoteData: {
          unit: 'sat',
          amount: { amount: Amount.from(10), unit: 'sat' },
        },
      }),
    ).rejects.toThrow('does not match requested amount');
  });

  it('rejects fixed-amount quotes when the mint returns a different response amount', async () => {
    (wallet.createMintQuoteBolt12 as Mock<any>).mockImplementation(async () =>
      quote({ amount: Amount.from(21) }),
    );

    await expect(
      handler.createQuote({
        ...buildPrepareContext(),
        mintUrl,
        createQuoteData: {
          unit: 'sat',
          amount: { amount: Amount.from(10), unit: 'sat' },
        },
      }),
    ).rejects.toThrow('does not match requested amount');
  });

  it('creates amountless quotes with method-specific description data', async () => {
    (wallet.createMintQuoteBolt12 as Mock<any>).mockImplementation(async () =>
      quote({ amount: undefined }),
    );

    const result = await handler.createQuote({
      ...buildPrepareContext(),
      mintUrl,
      createQuoteData: {
        unit: 'sat',
        description: 'pay any amount',
      },
    });

    expect(wallet.createMintQuoteBolt12).toHaveBeenCalledWith(pubkey, {
      amount: undefined,
      description: 'pay any amount',
    });
    expect(result.amount).toBeUndefined();
  });
});
