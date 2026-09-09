import { Amount, OutputData, type Wallet } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintOnchainHandler } from '../../infra/handlers/mint/MintOnchainHandler';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { Logger } from '../../logging/Logger';
import { MintQuoteValidationError } from '../../models/Error';
import { getMintQuoteAvailableAmount, type MintQuoteOnchainResponse } from '../../models/MintQuote';
import type {
  CreateMintQuoteContext,
  FetchRemoteMintQuoteContext,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
} from '../../operations/mint';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type { ProofRepository } from '../../repositories';
import type { KeyRingService, MintService, ProofService, WalletService } from '../../services';
import { serializeOutputData } from '../../utils';

describe('MintOnchainHandler', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'onchain-quote-1';
  const pubkey = '02'.padEnd(66, '1');

  let handler: MintOnchainHandler;
  let keyRingService: KeyRingService;
  let wallet: Wallet;
  let mintAdapter: MintAdapter;
  let proofService: ProofService;
  let proofRepository: ProofRepository;
  let walletService: WalletService;
  let mintService: MintService;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;

  const remoteQuote: MintQuoteOnchainResponse = {
    quote: quoteId,
    request: 'bc1qtestaddress',
    method: 'onchain',
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    pubkey,
    amount_paid: Amount.from(21),
    amount_issued: Amount.from(8),
    updated_at: null,
  };

  const output = new OutputData(
    {
      amount: Amount.from(10),
      id: 'keyset-1',
      B_: 'B_out_1',
    },
    BigInt(1),
    new TextEncoder().encode('out-1'),
  );

  const buildCreateQuoteContext = (): CreateMintQuoteContext<'onchain'> => ({
    mintUrl,
    createQuoteData: { unit: 'sat' },
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildFetchRemoteQuoteContext = (): FetchRemoteMintQuoteContext<'onchain'> => ({
    quote: {
      mintUrl,
      method: 'onchain',
      quoteId,
      quote: quoteId,
      request: remoteQuote.request,
      unit: 'sat',
      expiry: remoteQuote.expiry,
      pubkey,
      reusable: true,
      amountPaid: Amount.zero(),
      amountIssued: Amount.zero(),
      remoteUpdatedAt: null,
      quoteData: {
        pubkey,
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

  const buildPrepareContext = (): PrepareContext<'onchain'> => ({
    operation: {
      id: 'op-1',
      state: 'init',
      mintUrl,
      amount: Amount.from(10),
      unit: 'sat',
      method: 'onchain',
      methodData: {},
      quoteId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies InitMintOperation<'onchain'>,
    wallet,
    mintAdapter,
    proofService,
    proofRepository,
    walletService,
    mintService,
    eventBus,
    logger,
  });

  const buildExecutingOperation = (): ExecutingMintOperation<'onchain'> => ({
    ...buildPrepareContext().operation,
    state: 'executing',
    quoteId,
    request: remoteQuote.request,
    expiry: remoteQuote.expiry,
    pubkey,
    outputData: serializeOutputData({ keep: [output], send: [] }),
  });

  const buildRecoverContext = (
    localClaimabilityFacts = {
      finalizedAmount: Amount.zero(),
      reservedAmount: Amount.zero(),
    },
  ): RecoverExecutingContext<'onchain'> => ({
    ...buildPrepareContext(),
    operation: buildExecutingOperation(),
    localClaimabilityFacts,
  });

  const buildPendingContext = (): PendingContext<'onchain'> => ({
    operation: {
      ...buildExecutingOperation(),
      state: 'pending',
    } satisfies PendingMintOperation<'onchain'>,
    mintAdapter,
    logger,
  });

  beforeEach(() => {
    keyRingService = {
      generateMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: pubkey,
        secretKey: new Uint8Array(32),
        derivationIndex: 0,
        purpose: 'nut20_mint_quote' as const,
      })),
      getMintQuoteKeyPair: mock(async () => ({
        publicKeyHex: pubkey,
        secretKey: new Uint8Array(32),
        derivationIndex: 0,
        purpose: 'nut20_mint_quote' as const,
      })),
    } as unknown as KeyRingService;

    handler = new MintOnchainHandler(keyRingService);

    wallet = {
      createMintQuoteOnchain: mock(async () => remoteQuote),
      mintProofsOnchain: mock(async () => [
        {
          id: 'keyset-1',
          amount: Amount.from(10),
          secret: 'out-1',
          C: 'C_out_1',
        },
      ]),
    } as unknown as Wallet;

    mintAdapter = {
      checkMintQuote: mock(async () => remoteQuote),
    } as unknown as MintAdapter;

    proofService = {
      createOutputsAndIncrementCounters: mock(async () => ({ keep: [output], send: [] })),
      saveProofs: mock(async () => {}),
      recoverProofsFromOutputData: mock(async () => []),
    } as unknown as ProofService;
    proofRepository = {} as ProofRepository;
    walletService = {} as WalletService;
    mintService = {} as MintService;
    eventBus = new EventBus<CoreEvents>();
    logger = { info: mock(() => {}), warn: mock(() => {}) } as unknown as Logger;
  });

  it('creates an onchain quote with a fresh NUT-20 public key', async () => {
    const result = await handler.createQuote(buildCreateQuoteContext());

    expect(keyRingService.generateMintQuoteKeyPair).toHaveBeenCalled();
    expect(wallet.createMintQuoteOnchain).toHaveBeenCalledWith(pubkey);
    expect(result.method).toBe('onchain');
    expect(result.reusable).toBe(true);
    expect(result.quoteData.pubkey).toBe(pubkey);
    expect(result.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(result.amountIssued.equals(Amount.from(8))).toBe(true);
    expect(getMintQuoteAvailableAmount(result).equals(Amount.from(13))).toBe(true);
  });

  it('derives a distinct NUT-20 public key for each new onchain quote', async () => {
    const firstPubkey = '02'.padEnd(66, '1');
    const secondPubkey = '02'.padEnd(66, '2');
    const pubkeys = [firstPubkey, secondPubkey];

    (keyRingService.generateMintQuoteKeyPair as Mock<any>).mockImplementation(async () => {
      const nextPubkey = pubkeys.shift();
      if (!nextPubkey) throw new Error('unexpected key generation');
      return {
        publicKeyHex: nextPubkey,
        secretKey: new Uint8Array(32),
        derivationIndex: 0,
        purpose: 'nut20_mint_quote' as const,
      };
    });
    (wallet.createMintQuoteOnchain as Mock<any>).mockImplementation(
      async (payloadPubkey: string) => ({
        ...remoteQuote,
        quote: `quote-${payloadPubkey.at(-1)}`,
        pubkey: payloadPubkey,
      }),
    );

    const first = await handler.createQuote(buildCreateQuoteContext());
    const second = await handler.createQuote(buildCreateQuoteContext());

    expect(first.quoteData.pubkey).toBe(firstPubkey);
    expect(second.quoteData.pubkey).toBe(secondPubkey);
    expect(first.quoteData.pubkey).not.toBe(second.quoteData.pubkey);
  });

  it('rejects an onchain quote that returns a different pubkey', async () => {
    (wallet.createMintQuoteOnchain as Mock<any>).mockImplementationOnce(async () => ({
      ...remoteQuote,
      pubkey: '02'.padEnd(66, '2'),
    }));

    const error = await handler.createQuote(buildCreateQuoteContext()).catch((caught) => caught);

    expect(error).toBeInstanceOf(MintQuoteValidationError);
    expect(error.message).toContain('instead of requested pubkey');
  });

  it('fetches the latest onchain quote through the mint adapter', async () => {
    const result = await handler.fetchRemoteQuote(buildFetchRemoteQuoteContext());

    expect(mintAdapter.checkMintQuote).toHaveBeenCalledWith(mintUrl, 'onchain', quoteId);
    expect(result.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(result.amountIssued.equals(Amount.from(8))).toBe(true);
  });
});
