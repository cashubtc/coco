import { Amount, OutputData, type Wallet } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import { MintOnchainHandler } from '../../infra/handlers/mint/MintOnchainHandler';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { Logger } from '../../logging/Logger';
import { MintOperationError } from '../../models/Error';
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  FetchRemoteMintQuoteContext,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
} from '../../operations/mint';
import { getMintQuoteAvailableAmount, type MintQuoteOnchainResponse } from '../../models/MintQuote';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation';
import type { ProofRepository } from '../../repositories';
import type { KeyRingService, MintService, ProofService, WalletService } from '../../services';
import { deserializeOutputData, serializeOutputData } from '../../utils';

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
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    pubkey,
    amount_paid: Amount.from(21),
    amount_issued: Amount.from(8),
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
      quoteData: {
        pubkey,
        amountPaid: Amount.from(0),
        amountIssued: Amount.from(0),
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

  const buildRecoverContext = (): RecoverExecutingContext<'onchain'> => ({
    ...buildPrepareContext(),
    operation: buildExecutingOperation(),
  });

  const buildPendingContext = (): PendingContext<'onchain'> => ({
    ...buildPrepareContext(),
    operation: {
      ...buildExecutingOperation(),
      state: 'pending',
    } satisfies PendingMintOperation<'onchain'>,
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
      checkMintQuoteOnchain: mock(async () => remoteQuote),
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
    expect(result.quoteData.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(result.quoteData.amountIssued.equals(Amount.from(8))).toBe(true);
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

    await expect(handler.createQuote(buildCreateQuoteContext())).rejects.toThrow(
      'instead of requested pubkey',
    );
  });

  it('fetches the latest onchain quote through the mint adapter', async () => {
    const result = await handler.fetchRemoteQuote(buildFetchRemoteQuoteContext());

    expect(mintAdapter.checkMintQuoteOnchain).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(result.quoteData.amountPaid.equals(Amount.from(21))).toBe(true);
    expect(result.quoteData.amountIssued.equals(Amount.from(8))).toBe(true);
  });

  it('prepares deterministic outputs without requiring available quote balance', async () => {
    const result = await handler.prepare({
      ...buildPrepareContext(),
      importedQuote: { ...remoteQuote, amount_paid: Amount.zero(), amount_issued: Amount.zero() },
    });

    expect(keyRingService.getMintQuoteKeyPair).toHaveBeenCalledWith(pubkey);
    expect(proofService.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
      mintUrl,
      {
        keep: { amount: Amount.from(10), unit: 'sat' },
        send: { amount: Amount.zero(), unit: 'sat' },
      },
      {},
    );
    expect(result.state).toBe('pending');
    expect(result.quoteId).toBe(quoteId);
    expect(result.pubkey).toBe(pubkey);
    expect(deserializeOutputData(result.outputData).keep).toHaveLength(1);
  });

  it('fails onchain preparation when the quote key is missing', async () => {
    (keyRingService.getMintQuoteKeyPair as Mock<any>).mockResolvedValueOnce(null);

    await expect(
      handler.prepare({ ...buildPrepareContext(), importedQuote: remoteQuote }),
    ).rejects.toThrow('Missing NUT-20 mint quote key');
  });

  it('executes onchain mint proofs with the persisted quote key', async () => {
    const pending = await handler.prepare({
      ...buildPrepareContext(),
      importedQuote: remoteQuote,
    });
    const context: ExecuteContext<'onchain'> = {
      ...buildPrepareContext(),
      operation: {
        ...pending,
        state: 'executing',
      },
    };

    const result = await handler.execute(context);

    expect(result.status).toBe('ISSUED');
    expect(mintAdapter.checkMintQuoteOnchain).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(wallet.mintProofsOnchain).toHaveBeenCalledWith(
      Amount.from(10),
      remoteQuote,
      ''.padEnd(64, '0'),
      undefined,
      { type: 'custom', data: deserializeOutputData(pending.outputData).keep },
    );
  });

  it('recovers signed onchain outputs before retrying the mint', async () => {
    (proofService.recoverProofsFromOutputData as Mock<any>).mockResolvedValueOnce([
      {
        id: 'keyset-1',
        amount: Amount.from(10),
        secret: 'out-1',
        C: 'C_out_1',
      },
    ]);

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(proofService.recoverProofsFromOutputData).toHaveBeenCalled();
    expect(wallet.mintProofsOnchain).not.toHaveBeenCalled();
  });

  it('retries onchain minting from persisted output data when the quote is still available', async () => {
    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(proofService.recoverProofsFromOutputData).toHaveBeenCalled();
    expect(wallet.mintProofsOnchain).toHaveBeenCalledWith(
      Amount.from(10),
      remoteQuote,
      ''.padEnd(64, '0'),
      undefined,
      { type: 'custom', data: [output] },
    );
    expect(proofService.saveProofs).toHaveBeenCalled();
  });

  it('returns pending during recovery when output restore is empty and balance is unavailable', async () => {
    (mintAdapter.checkMintQuoteOnchain as Mock<any>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(8),
      amount_issued: Amount.from(8),
    });

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result.status).toBe('PENDING');
    expect(wallet.mintProofsOnchain).not.toHaveBeenCalled();
  });

  it('attempts restore again after an already-issued retry result', async () => {
    (wallet.mintProofsOnchain as Mock<any>).mockImplementationOnce(async () => {
      throw new MintOperationError(20002, 'already issued');
    });
    (proofService.recoverProofsFromOutputData as Mock<any>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'keyset-1',
          amount: Amount.from(10),
          secret: 'out-1',
          C: 'C_out_1',
        },
      ]);

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(proofService.recoverProofsFromOutputData).toHaveBeenCalledTimes(2);
  });

  it('marks expired onchain executing recovery as terminal after restore misses', async () => {
    (mintAdapter.checkMintQuoteOnchain as Mock<any>).mockResolvedValueOnce({
      ...remoteQuote,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });

    const result = await handler.recoverExecuting(buildRecoverContext());

    expect(result).toEqual({
      status: 'TERMINAL',
      error: `Recovered: onchain quote ${quoteId} expired while executing mint`,
    });
  });

  it('checks pending onchain operations as ready when the quote can cover the amount', async () => {
    const result = await handler.checkPending(buildPendingContext());

    expect(result.category).toBe('ready');
    expect(result.quoteSnapshot).toBe(remoteQuote);
  });

  it('checks pending onchain operations as waiting when the quote cannot cover the amount', async () => {
    (mintAdapter.checkMintQuoteOnchain as Mock<any>).mockResolvedValueOnce({
      ...remoteQuote,
      amount_paid: Amount.from(8),
      amount_issued: Amount.from(0),
    });

    const result = await handler.checkPending(buildPendingContext());

    expect(result.category).toBe('waiting');
    expect(result.quoteSnapshot?.amount_paid.equals(Amount.from(8))).toBe(true);
  });

  it('checks expired pending onchain operations as terminal', async () => {
    (mintAdapter.checkMintQuoteOnchain as Mock<any>).mockResolvedValueOnce({
      ...remoteQuote,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });

    const result = await handler.checkPending(buildPendingContext());

    expect(result.category).toBe('terminal');
    expect(result.terminalFailure?.code).toBe('quote_expired');
  });
});
