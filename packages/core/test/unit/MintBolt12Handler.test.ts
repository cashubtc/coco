import { Amount, OutputData, type MintQuoteBolt12Response, type Wallet } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MintBolt12Handler } from '../../infra/handlers/mint/MintBolt12Handler';
import type { Logger } from '../../logging/Logger';
import {
  MintOperationError,
  MintQuoteKeyError,
  MintQuoteValidationError,
} from '../../models/Error';
import { mintQuoteFromBolt12Response } from '../../models/MintQuote';
import type { ProofRepository } from '../../repositories';
import type { KeyRingService } from '../../services/KeyRingService';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type {
  ExecuteContext,
  FetchRemoteMintQuoteContext,
  PendingContext,
  PrepareContext,
  RecoverExecutingContext,
} from '../../operations/mint';
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
      ...buildPrepareContext(),
      operation: {
        ...operation,
        state: 'pending',
        quoteId,
        request: remoteQuote.request,
        expiry: remoteQuote.expiry,
        pubkey,
        outputData,
      },
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

  it('prepares amountless imported quotes while preserving operation amount', async () => {
    const amountlessQuote = quote({ amount: undefined });

    const result = await handler.prepare(
      buildPrepareContext({
        importedQuote: amountlessQuote,
        operation: {
          ...operation,
        },
      }),
    );

    expect(wallet.createMintQuoteBolt12).not.toHaveBeenCalled();
    expect(result.amount).toEqual(Amount.from(10));
  });

  it('prepares fixed-amount offers with a different operation amount', async () => {
    const fixedOfferQuote = quote({ amount: Amount.from(21), amount_paid: Amount.from(63) });

    const result = await handler.prepare(
      buildPrepareContext({
        importedQuote: fixedOfferQuote,
        operation: {
          ...operation,
          amount: Amount.from(10),
        },
      }),
    );

    expect(wallet.createMintQuoteBolt12).not.toHaveBeenCalled();
    expect(result.amount).toEqual(Amount.from(10));
  });

  it('rejects imported quotes that do not match the bound operation quote id', async () => {
    await expect(
      handler.prepare(
        buildPrepareContext({
          importedQuote: quote({ quote: 'quote-other' }),
          operation: {
            ...operation,
            quoteId,
          },
        }),
      ),
    ).rejects.toThrow(`Mint quote quote-other does not match operation quote ${quoteId}`);

    expect(proofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
  });

  it('requires the imported quote pubkey to exist in the keyring', async () => {
    (keyRingService.getMintQuoteKeyPair as Mock<any>).mockImplementation(async () => null);

    const error = await handler
      .prepare(buildPrepareContext({ importedQuote: quote() }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(MintQuoteKeyError);
    expect(error.message).toContain('Missing NUT-20 mint quote key');
  });

  it('reports the validated remote snapshot for an amountless quote', async () => {
    const result = await handler.checkPending(
      buildPendingContext(
        quote({
          amount: undefined,
          amount_paid: Amount.from(15),
          amount_issued: Amount.from(4),
        }),
      ),
    );

    expect(result.quoteSnapshot?.quote).toBe(quoteId);
    expect(result.observedAt).toEqual(expect.any(Number));
  });

  it('reports an unattributable pending response as a validation failure', async () => {
    const context = buildPendingContext(quote());
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce(
      quote({ quote: 'other-quote' }),
    );

    const result = await handler.checkPending(context);

    expect(result.quoteSnapshot).toBeUndefined();
    expect(result.validationFailure).toMatchObject({
      code: 'invalid_quote',
      retryable: false,
    });
    expect(result.validationFailure?.reason).toContain('conflicts with pending operation identity');
  });

  it('does not attribute a mismatched response when the operation pubkey is missing', async () => {
    const baseContext = buildPendingContext(quote());
    (mintAdapter.checkMintQuote as Mock<any>).mockResolvedValueOnce(
      quote({ request: 'lno1other' }),
    );

    const result = await handler.checkPending({
      ...baseContext,
      operation: { ...baseContext.operation, pubkey: undefined },
    });

    expect(result.quoteSnapshot).toBeUndefined();
    expect(result.validationFailure?.code).toBe('invalid_quote');
  });

  it('preserves the missing-pubkey terminal code for an attributable response', async () => {
    const baseContext = buildPendingContext(quote());

    const result = await handler.checkPending({
      ...baseContext,
      operation: { ...baseContext.operation, pubkey: undefined },
    });

    expect(result.quoteSnapshot?.quote).toBe(quoteId);
    expect(result.validationFailure?.code).toBe('missing_quote_pubkey');
  });

  it('mints with the keyring private key and custom outputs', async () => {
    await handler.execute(
      buildExecuteContext(
        quote({
          amount_paid: Amount.from(10),
        }),
      ),
    );

    const call = (wallet.mintProofsBolt12 as Mock<any>).mock.calls[0]! as any[];
    expect(call[0]).toEqual(Amount.from(10));
    expect(call[1].quote).toBe(quoteId);
    expect(call[2]).toBe(bytesToHex(secretKey));
    expect(call[3]).toBeUndefined();
    expect(call[4].type).toBe('custom');
    expect(call[4].data).toHaveLength(1);
    expect(call[4].data[0].blindedMessage.B_).toBe('B_out_1');
  });

  it('rejects contradictory fresh accounting before mint submission', async () => {
    await expect(
      handler.execute(
        buildExecuteContext(
          quote({
            amount_paid: Amount.from(9),
            amount_issued: Amount.from(10),
          }),
        ),
      ),
    ).rejects.toThrow(`BOLT12 mint quote ${quoteId} is not claimable: invalid`);

    expect(wallet.mintProofsBolt12).not.toHaveBeenCalled();
  });

  it('does not let a stale valid fresh balance veto service-authorized execution', async () => {
    const result = await handler.execute(
      buildExecuteContext(
        quote({
          amount_paid: Amount.from(1),
          amount_issued: Amount.zero(),
        }),
      ),
    );

    expect(result.status).toBe('ISSUED');
    expect(wallet.mintProofsBolt12).toHaveBeenCalledTimes(1);
  });

  it('rejects execution when the remote quote pubkey changes', async () => {
    const changedPubkey = '02' + '22'.repeat(32);

    const error = await handler
      .execute(
        buildExecuteContext(
          quote({
            amount_paid: Amount.from(10),
            pubkey: changedPubkey,
          }),
        ),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(MintQuoteValidationError);
    expect(error.message).toContain(
      `BOLT12 mint quote ${quoteId} returned pubkey ${changedPubkey}`,
    );

    expect(wallet.mintProofsBolt12).not.toHaveBeenCalled();
  });

  it('recovers remote pubkey changes as terminal failures without signing', async () => {
    const changedPubkey = '02' + '33'.repeat(32);

    const result = await handler.recoverExecuting(
      buildRecoverContext(
        quote({
          amount_paid: Amount.from(10),
          pubkey: changedPubkey,
        }),
      ),
    );

    expect(result.status).toBe('TERMINAL');
    if (result.status !== 'TERMINAL') {
      throw new Error('Expected terminal recovery result');
    }
    expect(result.error).toContain(`BOLT12 mint quote ${quoteId} returned pubkey ${changedPubkey}`);
    expect(wallet.mintProofsBolt12).not.toHaveBeenCalled();
  });

  it('retries funded execution recovery after expiry', async () => {
    const expiredQuote = quote({
      expiry: Math.floor(Date.now() / 1000) - 1,
      amount_paid: Amount.from(10),
    });

    const result = await handler.recoverExecuting(buildRecoverContext(expiredQuote));

    expect(result).toEqual({ status: 'FINALIZED' });
    expect(wallet.mintProofsBolt12).toHaveBeenCalled();
    expect(proofService.saveProofs).toHaveBeenCalled();
  });

  it('fails recovery when the mint rejects BOLT12 issuance with quote expired', async () => {
    const expiredQuote = quote({
      expiry: Math.floor(Date.now() / 1000) - 1,
      amount_paid: Amount.from(10),
    });
    (wallet.mintProofsBolt12 as Mock<any>).mockRejectedValueOnce(
      new MintOperationError(20007, 'Quote expired'),
    );

    const result = await handler.recoverExecuting(buildRecoverContext(expiredQuote));

    expect(result).toEqual({
      status: 'TERMINAL',
      error: `Recovered: BOLT12 quote ${quoteId} expired while executing mint`,
    });
    expect(wallet.mintProofsBolt12).toHaveBeenCalledTimes(1);
    expect(proofService.saveProofs).not.toHaveBeenCalled();
  });

  it('keeps non-protocol expiry errors pending during BOLT12 recovery', async () => {
    const expiredQuote = quote({
      expiry: Math.floor(Date.now() / 1000) - 1,
      amount_paid: Amount.from(10),
    });
    (wallet.mintProofsBolt12 as Mock<any>).mockRejectedValueOnce(
      new Error('Authentication session expired'),
    );

    const result = await handler.recoverExecuting(buildRecoverContext(expiredQuote));

    expect(result).toEqual({
      status: 'PENDING',
      error: 'Authentication session expired',
    });
    expect(proofService.saveProofs).not.toHaveBeenCalled();
  });

  it('does not retry balance already consumed by finalized local operations', async () => {
    const result = await handler.recoverExecuting(
      buildRecoverContext(quote({ amount_paid: Amount.from(10) }), {
        finalizedAmount: Amount.from(10),
        reservedAmount: Amount.zero(),
      }),
    );

    expect(result.status).toBe('PENDING');
    expect(wallet.mintProofsBolt12).not.toHaveBeenCalled();
  });
});
