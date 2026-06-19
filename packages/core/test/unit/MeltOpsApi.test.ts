import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  ExecutingMeltOperation,
  FinalizedMeltOperation,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import { MeltOpsApi } from '../../api/MeltOpsApi.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type Assert<T extends true> = T;
type PrepareMeltInput = Parameters<MeltOpsApi['prepare']>[0];
type GetMeltByQuoteInput = Parameters<MeltOpsApi['getByQuote']>[0];
type OnchainPrepareMeltInput = Extract<PrepareMeltInput, { quote: { method: 'onchain' } }>;
type Bolt11PrepareMeltInput = Extract<PrepareMeltInput, { quote: { method: 'bolt11' } }>;
type _AssertDefaultBoltMethods = Assert<
  Exclude<PrepareMeltInput['quote']['method'], 'bolt11' | 'bolt12' | 'onchain'> extends never
    ? true
    : false
>;
type CustomPrepareMeltInput = Parameters<MeltOpsApi<'bolt11' | 'bolt12'>['prepare']>[0];
type _AssertAllowsBolt12 = Assert<
  'bolt12' extends CustomPrepareMeltInput['quote']['method'] ? true : false
>;
type _AssertPrepareAcceptsQuoteRef = Assert<
  PrepareMeltInput extends {
    quote: {
      mintUrl: string;
      quoteId: string;
      method: 'bolt11' | 'bolt12' | 'onchain';
    };
  }
    ? true
    : false
>;
type _AssertPrepareOmitsLooseMethod = Assert<
  'method' extends keyof PrepareMeltInput ? false : true
>;
type _AssertPrepareOmitsLooseUnit = Assert<'unit' extends keyof PrepareMeltInput ? false : true>;
type _AssertPrepareOmitsMethodData = Assert<
  'methodData' extends keyof PrepareMeltInput ? false : true
>;
type _AssertOnchainRequiresFeeIndex = Assert<
  OnchainPrepareMeltInput extends { feeIndex: number } ? true : false
>;
type _AssertBoltFeeIndexOptional = Assert<
  Bolt11PrepareMeltInput extends { feeIndex?: number } ? true : false
>;
type _AssertListByQuoteUsesQuoteIdentity = Assert<
  Parameters<MeltOpsApi['listByQuote']> extends [{ mintUrl: string; quoteId: string }]
    ? true
    : false
>;
type _AssertGetByQuoteUsesObjectInput = Assert<
  GetMeltByQuoteInput extends {
    mintUrl: string;
    quoteId: string;
  }
    ? true
    : false
>;
type GenericPrepareMeltInput = Parameters<MeltOpsApi<'gift-card'>['prepare']>[0];
type GenericPrepareMeltReturn = Awaited<ReturnType<MeltOpsApi<'gift-card'>['prepare']>>;
type _AssertGenericMeltPrepareAcceptsArbitraryMethod = Assert<
  GenericPrepareMeltInput extends {
    quote: {
      mintUrl: string;
      quoteId: string;
      method: 'gift-card';
    };
    feeIndex?: number;
  }
    ? true
    : false
>;
type _AssertGenericMeltPrepareReturnPreservesMethod = Assert<
  GenericPrepareMeltReturn extends PreparedMeltOperation<'gift-card'> ? true : false
>;

const supportedPrepareInput: PrepareMeltInput = {
  quote: {
    mintUrl,
    method: 'bolt11',
    quoteId,
  },
};
void supportedPrepareInput;

const makePreparedOperation = (): PreparedMeltOperation => ({
  id: 'op-1',
  state: 'prepared',
  mintUrl,
  method: 'bolt11',
  methodData: { invoice: 'lnbc1test' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  quoteId,
  unit: 'sat',
  amount: Amount.from(100),
  fee_reserve: Amount.from(0),
  swap_fee: Amount.from(0),
  needsSwap: false,
  inputAmount: Amount.from(100),
  inputProofSecrets: [],
  changeOutputData: { keep: [], send: [] },
});

describe('MeltOpsApi', () => {
  let api: MeltOpsApi;
  let meltOperationService: MeltOperationService;
  let preparedOperation: PreparedMeltOperation;
  let executingOperation: ExecutingMeltOperation;
  let pendingOperation: PendingMeltOperation;

  beforeEach(() => {
    preparedOperation = makePreparedOperation();
    pendingOperation = {
      ...preparedOperation,
      state: 'pending',
    };
    executingOperation = {
      ...preparedOperation,
      state: 'executing',
    };

    meltOperationService = {
      init: mock(async () => ({ id: 'op-1' })),
      prepare: mock(async () => preparedOperation),
      execute: mock(async () => pendingOperation),
      getOperation: mock(async () => preparedOperation),
      getOperationByQuoteIdentity: mock(async () => preparedOperation),
      listOperationsByQuote: mock(async () => [preparedOperation]),
      prepareExistingQuote: mock(async () => preparedOperation),
      getPreparedOperations: mock(async () => [preparedOperation]),
      getPendingOperations: mock(async () => [pendingOperation]),
      rollback: mock(async () => {}),
      finalize: mock(async () => {}),
      recoverPendingOperations: mock(async () => {}),
      recoverExecutingOperation: mock(async () => {}),
      checkPendingOperation: mock(async () => 'finalize'),
      isOperationLocked: mock(() => false),
      isRecoveryInProgress: mock(() => false),
    } as unknown as MeltOperationService;

    api = new MeltOpsApi(meltOperationService);
  });

  it('prepare creates and prepares a melt operation', async () => {
    const result = await api.prepare(supportedPrepareInput);

    expect(meltOperationService.prepareExistingQuote).toHaveBeenCalledWith(
      supportedPrepareInput.quote,
      { feeIndex: undefined },
    );
    expect(result).toBe(preparedOperation);
  });

  it('prepare accepts a full canonical quote as the quote ref', async () => {
    const quote: MeltQuote<'bolt11'> = {
      mintUrl,
      quoteId,
      quote: quoteId,
      request: 'lnbc1test',
      unit: 'usd',
      method: 'bolt11',
      amount: Amount.from(12),
      fee_reserve: Amount.from(1),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID',
      lastObservedRemoteState: 'UNPAID',
      lastObservedRemoteStateAt: Date.now(),
      payment_preimage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await api.prepare({
      quote,
    });

    expect(meltOperationService.prepareExistingQuote).toHaveBeenCalledWith(quote, {
      feeIndex: undefined,
    });
  });

  it('prepare passes onchain feeIndex to the service', async () => {
    const quote = { mintUrl, method: 'onchain', quoteId } as const;

    await api.prepare({
      quote,
      feeIndex: 2,
    });

    expect(meltOperationService.prepareExistingQuote).toHaveBeenCalledWith(quote, {
      feeIndex: 2,
    });
  });

  it('prepare ignores extra BOLT feeIndex at the API boundary', async () => {
    const quote = { mintUrl, method: 'bolt12', quoteId } as const;

    await api.prepare({
      quote,
      feeIndex: 9,
    });

    expect(meltOperationService.prepareExistingQuote).toHaveBeenCalledWith(quote, {
      feeIndex: 9,
    });
  });

  it('execute resolves ids before executing', async () => {
    const result = await api.execute(preparedOperation.id);

    expect(meltOperationService.getOperation).toHaveBeenCalledWith(preparedOperation.id);
    expect(meltOperationService.execute).toHaveBeenCalledWith(preparedOperation.id);
    expect(result).toBe(pendingOperation);
  });

  it('getByQuote forwards to the service', async () => {
    const result = await api.getByQuote({
      mintUrl,
      quoteId: preparedOperation.quoteId,
    });

    expect(meltOperationService.getOperationByQuoteIdentity).toHaveBeenCalledWith({
      mintUrl,
      quoteId: preparedOperation.quoteId,
    });
    expect(result).toBe(preparedOperation);
  });

  it('listByQuote forwards to the service', async () => {
    const result = await api.listByQuote({ mintUrl, quoteId: preparedOperation.quoteId });

    expect(meltOperationService.listOperationsByQuote).toHaveBeenCalledWith(
      mintUrl,
      preparedOperation.quoteId,
    );
    expect(result).toEqual([preparedOperation]);
  });

  it('listPrepared and listInFlight delegate to separate service methods', async () => {
    const prepared = await api.listPrepared();
    const inFlight = await api.listInFlight();

    expect(meltOperationService.getPreparedOperations).toHaveBeenCalledWith();
    expect(meltOperationService.getPendingOperations).toHaveBeenCalledWith();
    expect(prepared).toEqual([preparedOperation]);
    expect(inFlight).toEqual([pendingOperation]);
  });

  it('refresh checks pending operations and re-reads the latest state', async () => {
    const finalizedOperation: FinalizedMeltOperation = {
      ...pendingOperation,
      state: 'finalized',
      updatedAt: Date.now(),
    };
    (meltOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(pendingOperation as MeltOperation)
      .mockResolvedValueOnce(finalizedOperation as MeltOperation);

    const result = await api.refresh(pendingOperation.id);

    expect(meltOperationService.checkPendingOperation).toHaveBeenCalledWith(pendingOperation.id);
    expect(result).toBe(finalizedOperation);
  });

  it('refresh recovers executing operations and re-reads the latest state', async () => {
    const finalizedOperation: FinalizedMeltOperation = {
      ...pendingOperation,
      state: 'finalized',
      updatedAt: Date.now(),
    };
    (meltOperationService.getOperation as unknown as ReturnType<typeof mock>)
      .mockResolvedValueOnce(executingOperation as MeltOperation)
      .mockResolvedValueOnce(finalizedOperation as MeltOperation);

    const result = await api.refresh(executingOperation.id);

    expect(meltOperationService.recoverExecutingOperation).toHaveBeenCalledWith(executingOperation);
    expect(result).toBe(finalizedOperation);
  });

  it('cancel and reclaim validate operation state', async () => {
    await api.cancel(preparedOperation.id);
    expect(meltOperationService.rollback).toHaveBeenCalledWith(preparedOperation.id, undefined);

    (meltOperationService.getOperation as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
      pendingOperation as MeltOperation,
    );
    await api.reclaim(pendingOperation.id, 'user requested');

    expect(meltOperationService.rollback).toHaveBeenCalledWith(
      pendingOperation.id,
      'user requested',
    );
  });
});
