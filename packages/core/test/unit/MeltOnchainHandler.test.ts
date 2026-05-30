import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { MeltOnchainHandler } from '../../infra/handlers/melt/MeltOnchainHandler.ts';
import type {
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
} from '../../operations/melt/MeltMethodHandler.ts';
import type { ExecutingMeltOperation, InitMeltOperation } from '../../operations/melt';

const mintUrl = 'https://mint.test';
const quoteId = 'onchain-quote';

const remoteQuote = {
  quote: quoteId,
  request: 'bc1ptest',
  amount: Amount.from(21),
  unit: 'sat',
  fee_options: [
    { fee_index: 1, fee_reserve: Amount.from(1), estimated_blocks: 12 },
    { fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 3 },
  ],
  selected_fee_index: null,
  expiry: Math.floor(Date.now() / 1000) + 3600,
  state: 'UNPAID' as const,
  outpoint: null as string | null,
};

const baseDeps = (): any => ({
  proofRepository: {
    getProofsByOperationId: mock(async () => []),
  },
  proofService: {
    selectProofsToSend: mock(async () => []),
    reserveProofs: mock(async () => undefined),
    createBlankOutputs: mock(async () => []),
    createOutputsAndIncrementCounters: mock(async () => ({ keep: [], send: [] })),
    setProofState: mock(async () => undefined),
    restoreProofsToReady: mock(async () => undefined),
    unblindAndSaveChangeProofs: mock(async () => undefined),
  },
  walletService: {
    getWalletWithActiveKeysetId: mock(async () => ({ wallet: {} })),
  },
  mintService: {},
  mintAdapter: {
    customMeltOnchain: mock(async () => ({ ...remoteQuote, state: 'PAID' as const })),
    checkMeltQuoteOnchain: mock(async () => ({ ...remoteQuote, state: 'PAID' as const })),
    checkMeltQuoteOnchainState: mock(async () => 'PAID' as const),
    checkProofStates: mock(async () => []),
  },
  eventBus: {
    emit: mock(async () => undefined),
  },
});

const buildInitOperation = (): InitMeltOperation & { method: 'onchain'; quoteId: string } => ({
  id: 'op-1',
  state: 'init',
  mintUrl,
  method: 'onchain',
  methodData: { address: 'bc1ptest', amountSats: Amount.from(21), feeIndex: 7 },
  unit: 'sat',
  quoteId,
  createdAt: 0,
  updatedAt: 0,
});

const buildExecutingOperation = (): ExecutingMeltOperation & { method: 'onchain' } => ({
  ...buildInitOperation(),
  state: 'executing',
  amount: Amount.from(21),
  fee_reserve: Amount.from(2),
  swap_fee: Amount.zero(),
  needsSwap: false,
  inputAmount: Amount.from(23),
  inputProofSecrets: ['secret-1'],
  changeOutputData: { keep: [], send: [] },
});

describe('MeltOnchainHandler', () => {
  it('creates canonical onchain melt quotes with fee options', async () => {
    const handler = new MeltOnchainHandler();
    const wallet = {
      createMeltQuoteOnchain: mock(async () => remoteQuote),
    };
    const ctx = {
      ...baseDeps(),
      mintUrl,
      methodData: { address: 'bc1ptest', amountSats: Amount.from(21) },
      unit: 'sat',
      wallet,
    } as unknown as CreateMeltQuoteContext<'onchain'>;

    const quote = await handler.createQuote(ctx);

    expect(wallet.createMeltQuoteOnchain).toHaveBeenCalledWith('bc1ptest', Amount.from(21));
    expect(quote.method).toBe('onchain');
    if (quote.method !== 'onchain') throw new Error('Expected onchain quote');
    expect(quote.fee_options).toHaveLength(2);
    expect(quote.fee_options[1]!.fee_index).toBe(7);
  });

  it('prepares using the selected fee option reserve', async () => {
    const handler = new MeltOnchainHandler();
    const deps = baseDeps();
    const inputProof = { amount: 23, secret: 'secret-1' };
    deps.proofService.selectProofsToSend = mock(async () => [inputProof]);
    const ctx = {
      ...deps,
      operation: buildInitOperation(),
      wallet: {},
      quote: remoteQuote,
    } as unknown as BasePrepareContext<'onchain'>;

    const prepared = await handler.prepare(ctx);

    expect(prepared.fee_reserve).toEqual(Amount.from(2));
    expect(prepared.methodData.feeIndex).toBe(7);
    expect(deps.proofService.selectProofsToSend).toHaveBeenCalledWith(
      mintUrl,
      { amount: Amount.from(23), unit: 'sat' },
      true,
    );
  });

  it('executes with the selected fee index and stores optional outpoint finalized data', async () => {
    const handler = new MeltOnchainHandler();
    const deps = baseDeps();
    const proof = { amount: 23, secret: 'secret-1' };
    deps.proofRepository.getProofsByOperationId = mock(async () => [proof]);
    deps.mintAdapter.customMeltOnchain = mock(async () => ({
      ...remoteQuote,
      state: 'PAID' as const,
      outpoint: 'txid:0',
    }));
    const operation = buildExecutingOperation();
    const ctx = {
      ...deps,
      operation,
      wallet: {},
      reservedProofs: [proof],
    } as unknown as ExecuteContext<'onchain'>;

    const result = await handler.execute(ctx);

    expect(deps.mintAdapter.customMeltOnchain).toHaveBeenCalledWith(
      mintUrl,
      [proof],
      [],
      quoteId,
      7,
    );
    expect(result.status).toBe('PAID');
    if (result.status !== 'PAID') throw new Error('Expected paid result');
    expect(result.finalized.finalizedData).toEqual({ outpoint: 'txid:0' });
  });

  it('allows synchronous PAID settlement without an outpoint', async () => {
    const handler = new MeltOnchainHandler();
    const deps = baseDeps();
    const proof = { amount: 23, secret: 'secret-1' };
    deps.proofRepository.getProofsByOperationId = mock(async () => [proof]);
    deps.mintAdapter.customMeltOnchain = mock(async () => ({
      ...remoteQuote,
      state: 'PAID' as const,
      outpoint: null,
    }));
    const ctx = {
      ...deps,
      operation: buildExecutingOperation(),
      wallet: {},
      reservedProofs: [proof],
    } as unknown as ExecuteContext<'onchain'>;

    const result = await handler.execute(ctx);

    expect(result.status).toBe('PAID');
    if (result.status !== 'PAID') throw new Error('Expected paid result');
    expect(result.finalized.finalizedData).toBeUndefined();
  });
});
