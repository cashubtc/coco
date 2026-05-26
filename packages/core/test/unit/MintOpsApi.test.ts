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
import type { MintQuoteBolt11Response } from '@cashu/cashu-ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type Assert<T extends true> = T;
type PrepareMintInput = Parameters<MintOpsApi['prepare']>[0];
type ImportMintQuoteInput = Parameters<MintOpsApi['importQuote']>[0];
type GetMintByQuoteInput = Parameters<MintOpsApi['getByQuote']>[0];
type _AssertBolt11PrepareAllowsOmittedMethodData = Assert<
  Extract<PrepareMintInput, { method: 'bolt11' }> extends {
    methodData?: Record<string, never>;
  }
    ? true
    : false
>;
type _AssertBolt11ImportAllowsOmittedMethodData = Assert<
  Extract<ImportMintQuoteInput, { method: 'bolt11' }> extends {
    methodData?: Record<string, never>;
  }
    ? true
    : false
>;
type _AssertGetByQuoteUsesObjectInput = Assert<
  GetMintByQuoteInput extends { mintUrl: string; method: 'bolt11'; quoteId: string }
    ? true
    : false
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
  lastObservedRemoteState: 'PAID',
  lastObservedRemoteStateAt: Date.now(),
  outputData: { keep: [], send: [] },
});

describe('MintOpsApi', () => {
  let api: MintOpsApi;
  let mintOperationService: MintOperationService;
  let pendingOperation: PendingMintOperation;
  let quote: MintQuoteBolt11Response;

  beforeEach(() => {
    pendingOperation = makePendingOperation();
    quote = {
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    };
    const executingOperation: ExecutingMintOperation = {
      ...pendingOperation,
      state: 'executing',
    };
    const finalizedOperation: TerminalMintOperation = {
      ...pendingOperation,
      state: 'finalized',
    };

    mintOperationService = {
      prepareExistingQuote: mock(async () => pendingOperation),
      importQuote: mock(async () => pendingOperation),
      execute: mock(async () => finalizedOperation),
      getOperation: mock(async () => pendingOperation),
      getOperationByQuote: mock(async () => pendingOperation),
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
    const result = await api.prepare({
      mintUrl,
      quoteId,
      method: 'bolt11',
    });

    expect(mintOperationService.prepareExistingQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      quoteId,
      {},
      undefined,
    );
    expect(result).toBe(pendingOperation);
  });

  it('prepare passes methodData and expected units to the service', async () => {
    await api.prepare({
      mintUrl,
      quoteId,
      unit: 'usd',
      method: 'bolt11',
      methodData: {},
    });

    expect(mintOperationService.prepareExistingQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      quoteId,
      {},
      'usd',
    );
  });

  it('importQuote delegates to the mint operation service', async () => {
    const result = await api.importQuote({
      mintUrl,
      quote,
      method: 'bolt11',
      methodData: {},
    });

    expect(mintOperationService.importQuote).toHaveBeenCalledWith(mintUrl, quote, 'bolt11', {});
    expect(result).toBe(pendingOperation);
  });

  it('importQuote defaults empty methodData for bolt11', async () => {
    const result = await api.importQuote({
      mintUrl,
      quote,
      method: 'bolt11',
    });

    expect(mintOperationService.importQuote).toHaveBeenCalledWith(mintUrl, quote, 'bolt11', {});
    expect(result).toBe(pendingOperation);
  });

  it('importQuote passes non-sat quote units to the service', async () => {
    const usdQuote = {
      ...quote,
      unit: 'usd',
    } as MintQuoteBolt11Response;

    await api.importQuote({
      mintUrl,
      quote: usdQuote,
      method: 'bolt11',
      methodData: {},
    });

    expect(mintOperationService.importQuote).toHaveBeenCalledWith(mintUrl, usdQuote, 'bolt11', {});
  });

  it('execute only allows pending operations', async () => {
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

    await expect(api.execute(pendingOperation.id)).rejects.toThrow("Expected 'pending'");
  });

  it('listPending and listInFlight delegate to separate service methods', async () => {
    const pending = await api.listPending();
    const inFlight = await api.listInFlight();

    expect(mintOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(mintOperationService.getInFlightOperations).toHaveBeenCalledWith();
    expect(pending).toEqual([pendingOperation]);
    expect(inFlight).toHaveLength(2);
  });

  it('getByQuote forwards object input to the service', async () => {
    const result = await api.getByQuote({
      mintUrl,
      method: 'bolt11',
      quoteId: pendingOperation.quoteId,
    });

    expect(mintOperationService.getOperationByQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      pendingOperation.quoteId,
    );
    expect(result).toBe(pendingOperation);
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
});
