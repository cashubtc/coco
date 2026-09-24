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
