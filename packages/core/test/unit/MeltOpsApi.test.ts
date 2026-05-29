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

type Assert<T extends true> = T;
type PrepareMeltInput = Parameters<MeltOpsApi['prepare']>[0];
type PrepareMeltMethod = PrepareMeltInput['method'];
type _AssertDefaultBoltMethods = Assert<
  Exclude<PrepareMeltMethod, 'bolt11' | 'bolt12'> extends never ? true : false
>;
type CustomPrepareMeltInput = Parameters<MeltOpsApi<'bolt11' | 'bolt12'>['prepare']>[0];
type _AssertAllowsBolt12 = Assert<'bolt12' extends CustomPrepareMeltInput['method'] ? true : false>;
type _AssertListByQuoteUsesMintAndQuoteArgs = Assert<
  Parameters<MeltOpsApi['listByQuote']> extends [string, string] ? true : false
>;

const supportedPrepareInput: PrepareMeltInput = {
  mintUrl,
  method: 'bolt11',
  quoteId: 'quote-1',
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
  quoteId: 'quote-1',
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
      getOperationByQuote: mock(async () => preparedOperation),
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
      mintUrl,
      'bolt11',
      'quote-1',
      undefined,
    );
    expect(result).toBe(preparedOperation);
  });

  it('prepare passes non-sat units to the service', async () => {
    await api.prepare({
      mintUrl,
      method: 'bolt11',
      quoteId: 'quote-1',
      unit: 'USD',
    });

    expect(meltOperationService.prepareExistingQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      'quote-1',
      'USD',
    );
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
      method: 'bolt11',
      quoteId: preparedOperation.quoteId,
    });

    expect(meltOperationService.getOperationByQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      preparedOperation.quoteId,
    );
    expect(result).toBe(preparedOperation);
  });

  it('listByQuote forwards to the service', async () => {
    const result = await api.listByQuote(mintUrl, preparedOperation.quoteId);

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
