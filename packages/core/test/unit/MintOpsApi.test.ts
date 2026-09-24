import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MintOpsApi } from '../../api/MintOpsApi.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type {
  ExecutingMintOperation,
  MintOperation,
  PendingMintOperation,
  TerminalMintOperation,
} from '../../operations/mint/MintOperation.ts';

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
  outputData: { keep: [], send: [] },
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

  it('execute delegates every persisted operation state to the service by ID', async () => {
    const states: MintOperation['state'][] = [
      'init',
      'pending',
      'executing',
      'finalized',
      'failed',
    ];

    for (const state of states) {
      const operation = {
        ...pendingOperation,
        id: `op-${state}`,
        state,
      } as MintOperation;
      (mintOperationService.execute as unknown as ReturnType<typeof mock>).mockResolvedValueOnce(
        operation,
      );

      const result = await api.execute(operation);

      expect(mintOperationService.execute).toHaveBeenLastCalledWith(operation.id);
      expect(result).toBe(operation);
    }

    expect(mintOperationService.getOperation).not.toHaveBeenCalled();
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
});
