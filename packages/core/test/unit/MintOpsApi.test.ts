import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MintOpsApi } from '../../api/MintOpsApi.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type {
  ExecutingMintOperation,
  FinalizedMintOperation,
  MintOperation,
  PendingMintOperation,
  TerminalMintOperation,
} from '../../operations/mint/MintOperation.ts';
import type { MintQuote } from '../../models/MintQuote.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type Assert<T extends true> = T;
type PrepareMintInput = Parameters<MintOpsApi['prepare']>[0];
type _AssertPrepareAcceptsQuoteRef = Assert<
  PrepareMintInput extends {
    quote: {
      mintUrl: string;
      quoteId: string;
      method: 'bolt11' | 'onchain' | 'bolt12';
    };
    amount: unknown;
  }
    ? true
    : false
>;
type _AssertPrepareOmitsLooseMethod = Assert<
  'method' extends keyof PrepareMintInput ? false : true
>;
type _AssertPrepareOmitsLooseUnit = Assert<'unit' extends keyof PrepareMintInput ? false : true>;
type _AssertPrepareOmitsMethodData = Assert<
  'methodData' extends keyof PrepareMintInput ? false : true
>;
type _AssertGetByQuoteRemoved = Assert<'getByQuote' extends keyof MintOpsApi ? false : true>;
type _AssertListByQuoteUsesQuoteIdentity = Assert<
  Parameters<MintOpsApi['listByQuote']> extends [{ mintUrl: string; quoteId: string }]
    ? true
    : false
>;
type _AssertDefaultAllowsBolt12Mint = Assert<
  'bolt12' extends PrepareMintInput['quote']['method'] ? true : false
>;
type PublicMintOperation = NonNullable<Awaited<ReturnType<MintOpsApi['get']>>>;
type _AssertPublicMintOperationOmitsOutputData = Assert<
  'outputData' extends keyof PublicMintOperation ? false : true
>;
type _AssertPublicMintOperationOmitsAttemptId = Assert<
  'attemptId' extends keyof PublicMintOperation ? false : true
>;

const makePendingOperation = (): PendingMintOperation => ({
  id: 'op-1',
  state: 'pending',
  mintUrl,
  quoteId,
  method: 'bolt11',
  methodData: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
  amount: Amount.from(10),
  unit: 'sat',
  request: 'lnbc1test',
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

describe('MintOpsApi', () => {
  let api: MintOpsApi;
  let mintOperationService: MintOperationService;
  let pendingOperation: PendingMintOperation;

  beforeEach(() => {
    pendingOperation = makePendingOperation();
    const executingOperation: ExecutingMintOperation = {
      ...pendingOperation,
      state: 'executing',
    };
    const finalizedOperation: TerminalMintOperation = {
      ...pendingOperation,
      state: 'finalized',
    };

    mintOperationService = {
      prepare: mock(async () => pendingOperation),
      execute: mock(async () => finalizedOperation),
      getOperation: mock(async () => pendingOperation),
      getOperationByQuote: mock(async () => pendingOperation),
      listOperationsByQuote: mock(async () => [pendingOperation]),
      getPendingOperations: mock(async () => [pendingOperation]),
      getInFlightOperations: mock(async () => [pendingOperation, executingOperation]),
      checkPendingOperation: mock(async () => ({
        observedRemoteState: 'UNPAID',
        observedRemoteStateAt: Date.now(),
        category: 'waiting',
      })),
      recoverExecutingOperation: mock(async () => {}),
      finalize: mock(async () => finalizedOperation),
      recoverPendingOperations: mock(async () => {}),
      isOperationLocked: mock(() => false),
      isRecoveryInProgress: mock(() => false),
    } as unknown as MintOperationService;

    api = new MintOpsApi(mintOperationService);
  });

  it('prepare targets an existing canonical quote and returns a pending mint operation', async () => {
    const quote = { mintUrl, quoteId, method: 'bolt11' } as const;

    const result = await api.prepare({
      quote,
      amount: 10,
    });

    expect(mintOperationService.prepare).toHaveBeenCalledWith(quote, Amount.from(10));
    expect(result).toEqual(pendingOperation);
  });

  it('prepare accepts a full canonical quote as the quote ref', async () => {
    const quote: MintQuote<'bolt11'> = {
      mintUrl,
      quoteId,
      quote: quoteId,
      request: 'lnbc1test',
      unit: 'usd',
      method: 'bolt11',
      amount: Amount.from(12),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
      lastObservedRemoteState: 'PAID',
      lastObservedRemoteStateAt: Date.now(),
      reusable: false,
      quoteData: {
        amount: Amount.from(12),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await api.prepare({
      quote,
      amount: Amount.from(12),
    });

    expect(mintOperationService.prepare).toHaveBeenCalledWith(quote, Amount.from(12));
  });

  it('prepare passes explicit onchain withdrawal amounts to the service', async () => {
    const quote = { mintUrl, quoteId, method: 'onchain' } as const;

    await api.prepare({
      quote,
      amount: 10,
    });

    expect(mintOperationService.prepare).toHaveBeenCalledWith(quote, Amount.from(10));
  });

  it('prepare passes explicit BOLT12 mint amounts to the service', async () => {
    const quote = { mintUrl, quoteId, method: 'bolt12' } as const;

    await api.prepare({
      quote,
      amount: 10,
    });

    expect(mintOperationService.prepare).toHaveBeenCalledWith(quote, Amount.from(10));
  });

  it('execute delegates pending, executing, and terminal operations to the service', async () => {
    const result = await api.execute(pendingOperation.id);

    expect(mintOperationService.getOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(mintOperationService.execute).toHaveBeenCalledWith(pendingOperation.id);
    expect(result.state).toBe('finalized');

    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      {
        ...pendingOperation,
        state: 'executing',
      } as MintOperation,
    );

    await expect(api.execute(pendingOperation.id)).resolves.toEqual(result);

    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      result,
    );

    await expect(api.execute(pendingOperation.id)).resolves.toEqual(result);
    expect(mintOperationService.execute).toHaveBeenCalledTimes(3);
  });

  it('get and listByQuote delegate to the service', async () => {
    const operation = await api.get(pendingOperation.id);
    const operations = await api.listByQuote({ mintUrl, quoteId });

    expect(mintOperationService.getOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(mintOperationService.listOperationsByQuote).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(operation).toEqual(pendingOperation);
    expect(operations).toEqual([pendingOperation]);
  });

  it('returns only allowlisted fields when the service supplies a durable record', async () => {
    const record = {
      ...pendingOperation,
      mintUrl: `${pendingOperation.mintUrl}/`,
      attemptId: 'attempt-1',
      counterStart: 42,
      recoveryMaterial: { secret: 'recovery-secret' },
    };
    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      record,
    );

    const operation = await api.get(record.id);

    expect(operation?.mintUrl).toBe(pendingOperation.mintUrl);
    expect(Object.keys(operation ?? {}).sort()).toEqual(
      [
        'amount',
        'createdAt',
        'expiry',
        'id',
        'method',
        'methodData',
        'mintUrl',
        'quoteId',
        'request',
        'state',
        'unit',
        'updatedAt',
      ].sort(),
    );
  });

  it('listPending and listInFlight delegate to separate service methods', async () => {
    const pending = await api.listPending();
    const inFlight = await api.listInFlight();

    expect(mintOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(mintOperationService.getInFlightOperations).toHaveBeenCalledWith();
    expect(pending).toEqual([pendingOperation]);
    expect(inFlight).toHaveLength(2);
  });

  it('checkPayment only allows pending operations', async () => {
    const result = await api.checkPayment(pendingOperation.id);

    expect(mintOperationService.getOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(mintOperationService.checkPendingOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(result.category).toBe('waiting');

    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      {
        ...pendingOperation,
        state: 'finalized',
      } as MintOperation,
    );

    await expect(api.checkPayment(pendingOperation.id)).rejects.toThrow("Expected 'pending'");
  });

  it('refresh reconciles pending and executing operations', async () => {
    const finalizedOperation: TerminalMintOperation = {
      ...pendingOperation,
      state: 'finalized',
    };

    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(pendingOperation as MintOperation)
      .mockResolvedValueOnce(finalizedOperation as MintOperation);

    const refreshedPending = await api.refresh(pendingOperation.id);

    expect(mintOperationService.checkPendingOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(refreshedPending).toBe(finalizedOperation);

    const executingOperation: ExecutingMintOperation = {
      ...pendingOperation,
      state: 'executing',
    };

    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(executingOperation as MintOperation)
      .mockResolvedValueOnce(finalizedOperation as MintOperation);

    const refreshedExecuting = await api.refresh(pendingOperation.id);

    expect(mintOperationService.recoverExecutingOperation).toHaveBeenCalledWith(executingOperation);
    expect(refreshedExecuting).toBe(finalizedOperation);
  });

  it('refresh returns terminal operations as-is', async () => {
    const finalizedOperation: TerminalMintOperation = {
      ...pendingOperation,
      state: 'finalized',
    };
    (mintOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      finalizedOperation as MintOperation,
    );

    const result = await api.refresh(finalizedOperation.id);

    expect(mintOperationService.checkPendingOperation).not.toHaveBeenCalled();
    expect(mintOperationService.recoverExecutingOperation).not.toHaveBeenCalled();
    expect(result).toBe(finalizedOperation);
  });

  it('finalize and helper APIs delegate to the service', async () => {
    const result = await api.finalize(pendingOperation.id);

    await api.recovery.run();
    const recoveryInProgress = api.recovery.inProgress();
    const locked = api.diagnostics.isLocked(pendingOperation.id);

    expect(mintOperationService.finalize).toHaveBeenCalledWith(pendingOperation.id);
    expect(mintOperationService.recoverPendingOperations).toHaveBeenCalledWith();
    expect(mintOperationService.isRecoveryInProgress).toHaveBeenCalledWith();
    expect(mintOperationService.isOperationLocked).toHaveBeenCalledWith(pendingOperation.id);
    expect(result.state).toBe('finalized');
    expect(recoveryInProgress).toBe(false);
    expect(locked).toBe(false);
  });
});
