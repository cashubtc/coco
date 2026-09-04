import {
  Amount,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedSignature,
  type Wallet,
} from '@cashu/cashu-ts';
import { mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import {
  BaseQuoteMeltHandler,
  type QuoteMeltResponse,
} from '../../infra/handlers/melt/BaseQuoteMeltHandler';
import type { Logger } from '../../logging/Logger';
import { meltQuoteFromBolt11Response, type MeltQuote } from '../../models/MeltQuote';
import type {
  BaseHandlerDeps,
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
  FetchRemoteMeltQuoteContext,
  FinalizeContext,
  FinalizeResult,
  MeltMethodMeta,
  MeltMethodQuoteSnapshot,
  PendingContext,
  RecoverExecutingContext,
  RollbackContext,
} from '../../operations/melt/MeltMethodHandler';
import type {
  ExecutingMeltOperation,
  InitMeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
  PreparedOrLaterOperation,
} from '../../operations/melt/MeltOperation';
import type { ProofRepository } from '../../repositories';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { CoreProof } from '../../types';
import type { SerializedOutputData } from '../../utils';

const NOW = 1_700_000_000_000;

export const QUOTE_MELT_FIXTURE = {
  mintUrl: 'https://mint.test',
  keysetId: 'keyset-1',
  invoice: 'lnbc1000n1...',
  offer: 'lno1offer',
  address: 'bc1ptest',
  quoteId: 'quote-123',
} as const;

type Quote = MeltMethodQuoteSnapshot<'bolt11'>;
type InitOperation = InitMeltOperation & MeltMethodMeta<'bolt11'>;
type PreparedOperation = PreparedMeltOperation & MeltMethodMeta<'bolt11'>;
type ExecutingOperation = ExecutingMeltOperation & MeltMethodMeta<'bolt11'>;
type PendingOperation = PendingMeltOperation & MeltMethodMeta<'bolt11'>;

interface HandlerHooks {
  createRemoteQuote(ctx: CreateMeltQuoteContext<'bolt11'>): Promise<Quote>;
  fetchRemoteMeltQuote(ctx: FetchRemoteMeltQuoteContext<'bolt11'>): Promise<Quote>;
  executeMelt(
    ctx: ExecuteContext<'bolt11'>,
    proofs: Proof[],
    change: OutputDataLike[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<'bolt11'>>;
  checkMeltQuote(
    ctx: FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
  ): Promise<QuoteMeltResponse<'bolt11'>>;
  checkMeltQuoteState(
    ctx: PendingContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
  ): Promise<Quote['state']>;
  getFeeReserveForQuote(quote: Quote, operation: InitOperation): Amount;
  buildFinalizedData(
    response: QuoteMeltResponse<'bolt11'>,
  ): FinalizeResult<'bolt11'>['finalizedData'];
}

class TestQuoteMeltHandler extends BaseQuoteMeltHandler<'bolt11'> {
  protected readonly method = 'bolt11' as const;

  constructor(private readonly hooks: HandlerHooks) {
    super();
  }

  protected createRemoteQuote(ctx: CreateMeltQuoteContext<'bolt11'>) {
    return this.hooks.createRemoteQuote(ctx);
  }
  protected fetchRemoteMeltQuote(ctx: FetchRemoteMeltQuoteContext<'bolt11'>) {
    return this.hooks.fetchRemoteMeltQuote(ctx);
  }
  protected executeMelt(
    ctx: ExecuteContext<'bolt11'>,
    proofs: Proof[],
    change: OutputDataLike[],
    quoteId: string,
  ) {
    return this.hooks.executeMelt(ctx, proofs, change, quoteId);
  }
  protected checkMeltQuote(ctx: FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>) {
    return this.hooks.checkMeltQuote(ctx);
  }
  protected checkMeltQuoteState(ctx: PendingContext<'bolt11'> | RecoverExecutingContext<'bolt11'>) {
    return this.hooks.checkMeltQuoteState(ctx);
  }
  protected getFeeReserveForQuote(quote: Quote, operation: InitOperation) {
    return this.hooks.getFeeReserveForQuote(quote, operation);
  }
  protected buildFinalizedData(response: QuoteMeltResponse<'bolt11'>) {
    return this.hooks.buildFinalizedData(response);
  }
}

export const makeQuoteMeltProof = (secret: string, amount = 10): Proof => ({
  amount: Amount.from(amount),
  C: `C_${secret}`,
  id: QUOTE_MELT_FIXTURE.keysetId,
  secret,
});

export const makeQuoteMeltCoreProof = (secret: string, amount = 10): CoreProof => ({
  ...makeQuoteMeltProof(secret, amount),
  mintUrl: QUOTE_MELT_FIXTURE.mintUrl,
  unit: 'sat',
  state: 'ready',
});

export function makeQuoteMeltOutputData(
  keep: Array<{ secret: string; amount?: number }> = [],
  send: Array<{ secret: string; amount?: number }> = [],
): SerializedOutputData {
  const output = (side: string, value: { secret: string; amount?: number }) => ({
    blindedMessage: {
      amount: value.amount ?? 10,
      id: QUOTE_MELT_FIXTURE.keysetId,
      B_: `B_${side}_${value.secret}`,
    },
    blindingFactor: side === 'keep' ? '1234567890abcdef' : 'abcdef1234567890',
    secret: Buffer.from(value.secret).toString('hex'),
  });
  return {
    keep: keep.map((value) => output('keep', value)),
    send: send.map((value) => output('send', value)),
  } as SerializedOutputData;
}

export const makeQuoteMeltChange = (amount: number): SerializedBlindedSignature => ({
  amount: Amount.from(amount),
  id: QUOTE_MELT_FIXTURE.keysetId,
  C_: 'C_change',
});

export function createQuoteMeltTestDeps() {
  const f = QUOTE_MELT_FIXTURE;
  const boltQuote = (request: string, fee = 10) => ({
    quote: f.quoteId,
    request,
    amount: Amount.from(100),
    fee_reserve: Amount.from(fee),
    unit: 'sat',
    expiry: Math.floor(NOW / 1000) + 3600,
    state: 'UNPAID' as const,
    payment_preimage: null,
  });
  const onchainQuote = () => ({
    quote: f.quoteId,
    request: f.address,
    amount: Amount.from(21),
    unit: 'sat',
    fee_options: [
      { fee_index: 1, fee_reserve: Amount.from(1), estimated_blocks: 12 },
      { fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 3 },
    ],
    selected_fee_index: null,
    expiry: Math.floor(NOW / 1000) + 3600,
    state: 'UNPAID' as const,
    outpoint: null as string | null,
  });

  const mocks = {
    createMeltQuoteBolt11: mock(async () => boltQuote(f.invoice)),
    createMeltQuoteBolt12: mock(async () => boltQuote(f.offer, 12)),
    createMeltQuoteOnchain: mock(async () => onchainQuote()),
    getFeesForProofs: mock(() => Amount.from(1)),
    send: mock(async () => ({
      keep: [makeQuoteMeltProof('keep-1', 50)],
      send: [makeQuoteMeltProof('send-1', 60)],
    })),
    getProofsByOperationId: mock(async () => [] as CoreProof[]),
    selectProofsToSend: mock(async (..._args: Parameters<ProofService['selectProofsToSend']>) => [
      makeQuoteMeltProof('input-1', 60),
      makeQuoteMeltProof('input-2', 50),
    ]),
    reserveProofs: mock(async () => ({ amount: Amount.from(110) })),
    createBlankOutputs: mock(async () => [] as OutputDataLike[]),
    createOutputsAndIncrementCounters: mock(async () => ({ keep: [], send: [] })),
    setProofState: mock(async () => undefined),
    saveProofs: mock(async () => undefined),
    restoreProofsToReady: mock(async () => undefined),
    releaseProofs: mock(async () => undefined),
    unblindAndSaveChangeProofs: mock(async () => undefined),
    recoverProofsFromOutputData: mock(async () => [] as CoreProof[]),
    customMeltBolt11: mock(async () => ({
      state: 'PAID' as const,
      change: [],
      payment_preimage: 'preimage-123',
    })),
    checkMeltQuote: mock(async () => ({
      ...boltQuote(f.invoice),
      state: 'PAID' as const,
      change: [],
      payment_preimage: 'preimage-123',
    })),
    checkMeltQuoteState: mock(async () => 'PAID' as const),
    customMeltBolt12: mock(async () => ({
      state: 'PAID' as const,
      change: [],
      payment_preimage: 'preimage-12',
    })),
    checkMeltQuoteBolt12: mock(async () => ({
      ...boltQuote(f.offer, 12),
      state: 'PAID' as const,
      change: [],
      payment_preimage: 'preimage-12',
    })),
    checkMeltQuoteBolt12State: mock(async () => 'PAID' as const),
    customMeltOnchain: mock(async () => ({ ...onchainQuote(), state: 'PAID' as const })),
    checkMeltQuoteOnchain: mock(async () => ({ ...onchainQuote(), state: 'PAID' as const })),
    checkMeltQuoteOnchainState: mock(async () => 'PAID' as const),
    checkProofStates: mock(
      async (): Promise<Array<{ state: 'UNSPENT' | 'SPENT'; Y: string }>> => [
        { state: 'UNSPENT', Y: 'y1' },
      ],
    ),
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
  const wallet = {
    createMeltQuoteBolt11: mocks.createMeltQuoteBolt11,
    createMeltQuoteBolt12: mocks.createMeltQuoteBolt12,
    createMeltQuoteOnchain: mocks.createMeltQuoteOnchain,
    getFeesForProofs: mocks.getFeesForProofs,
    send: mocks.send,
  } as unknown as Wallet;
  const deps: BaseHandlerDeps = {
    proofRepository: {
      getProofsByOperationId: mocks.getProofsByOperationId,
    } as unknown as ProofRepository,
    proofService: {
      selectProofsToSend: mocks.selectProofsToSend,
      reserveProofs: mocks.reserveProofs,
      createBlankOutputs: mocks.createBlankOutputs,
      createOutputsAndIncrementCounters: mocks.createOutputsAndIncrementCounters,
      setProofState: mocks.setProofState,
      saveProofs: mocks.saveProofs,
      restoreProofsToReady: mocks.restoreProofsToReady,
      releaseProofs: mocks.releaseProofs,
      unblindAndSaveChangeProofs: mocks.unblindAndSaveChangeProofs,
      recoverProofsFromOutputData: mocks.recoverProofsFromOutputData,
    } as unknown as ProofService,
    walletService: {
      getWalletWithActiveKeysetId: mock(async () => ({ wallet, keysetId: f.keysetId })),
      getWallet: mock(async () => wallet),
    } as unknown as WalletService,
    mintService: {} as MintService,
    mintAdapter: mocks as unknown as MintAdapter,
    eventBus: new EventBus<CoreEvents>(),
    logger: mocks as unknown as Logger,
  };
  return { deps, wallet, mocks, boltQuote, onchainQuote };
}

export function createQuoteMeltHandlerHarness() {
  const shared = createQuoteMeltTestDeps();
  const { deps, wallet, mocks } = shared;
  const f = QUOTE_MELT_FIXTURE;
  const makeQuote = (overrides: Partial<Quote> = {}): Quote => ({
    ...shared.boltQuote(f.invoice),
    ...overrides,
  });
  const hooks = {
    createRemoteQuote: mock(async (_ctx: CreateMeltQuoteContext<'bolt11'>) => makeQuote()),
    fetchRemoteMeltQuote: mock(async (_ctx: FetchRemoteMeltQuoteContext<'bolt11'>) => makeQuote()),
    executeMelt: mock(
      async (
        _ctx: ExecuteContext<'bolt11'>,
        _proofs: Proof[],
        _change: OutputDataLike[],
        _quoteId: string,
      ): Promise<QuoteMeltResponse<'bolt11'>> => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-123',
      }),
    ),
    checkMeltQuote: mock(
      async (): Promise<QuoteMeltResponse<'bolt11'>> => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-123',
      }),
    ),
    checkMeltQuoteState: mock(async (): Promise<Quote['state']> => 'PAID'),
    getFeeReserveForQuote: mock((quote: Quote) => Amount.from(quote.fee_reserve)),
    buildFinalizedData: mock((response: QuoteMeltResponse<'bolt11'>) =>
      response.payment_preimage ? { preimage: response.payment_preimage } : undefined,
    ),
  } satisfies HandlerHooks;
  const handler = new TestQuoteMeltHandler(hooks);

  const makeInitOperation = (overrides: Partial<InitOperation> = {}): InitOperation => ({
    id: 'operation-1',
    state: 'init',
    mintUrl: f.mintUrl,
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice: f.invoice },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  const preparedData = {
    quoteId: f.quoteId,
    amount: Amount.from(100),
    fee_reserve: Amount.from(10),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(110),
    inputProofSecrets: ['input-1', 'input-2'],
    changeOutputData: makeQuoteMeltOutputData([{ secret: 'change-1' }]),
  };
  const makePreparedOperation = (
    overrides: Partial<PreparedOperation> = {},
  ): PreparedOperation => ({
    ...makeInitOperation(),
    ...preparedData,
    state: 'prepared',
    ...overrides,
  });
  const makeExecutingOperation = (
    overrides: Partial<ExecutingOperation> = {},
  ): ExecutingOperation => ({ ...makePreparedOperation(), state: 'executing', ...overrides });
  const makePendingOperation = (overrides: Partial<PendingOperation> = {}): PendingOperation => ({
    ...makePreparedOperation(),
    state: 'pending',
    ...overrides,
  });
  const makeCanonicalQuote = (
    overrides: Partial<MeltQuote<'bolt11'>> = {},
  ): MeltQuote<'bolt11'> => ({
    ...meltQuoteFromBolt11Response(f.mintUrl, makeQuote()),
    createdAt: NOW,
    updatedAt: NOW,
    lastObservedRemoteStateAt: NOW,
    ...overrides,
  });
  const context = { ...deps, wallet };

  const prepare = async (
    options: {
      operation?: InitOperation;
      quote?: Partial<Quote>;
      proofs?: Proof[];
    } = {},
  ) => {
    if (options.proofs) mocks.selectProofsToSend.mockResolvedValue(options.proofs);
    return handler.prepare({
      ...context,
      operation: options.operation ?? makeInitOperation(),
      quote: makeQuote(options.quote),
    });
  };
  const execute = async (
    options: {
      operation?: ExecutingOperation;
      proofs?: CoreProof[];
      response?: QuoteMeltResponse<'bolt11'>;
    } = {},
  ) => {
    const proofs = options.proofs ?? [
      makeQuoteMeltCoreProof('input-1', 60),
      makeQuoteMeltCoreProof('input-2', 50),
    ];
    mocks.getProofsByOperationId.mockResolvedValueOnce(proofs);
    if (options.response) hooks.executeMelt.mockResolvedValueOnce(options.response);
    return handler.execute({
      ...context,
      operation: options.operation ?? makeExecutingOperation(),
      reservedProofs: proofs,
    });
  };
  const finalize = async (
    options: {
      operation?: PendingOperation;
      quote?: MeltQuote<'bolt11'>;
      response?: QuoteMeltResponse<'bolt11'>;
    } = {},
  ) => {
    if (options.response) hooks.checkMeltQuote.mockResolvedValueOnce(options.response);
    return handler.finalize({
      ...deps,
      operation: options.operation ?? makePendingOperation(),
      canonicalQuote: options.quote,
    });
  };
  const checkPending = async (state: string, quote?: MeltQuote<'bolt11'>) => {
    if (!quote) hooks.checkMeltQuoteState.mockResolvedValueOnce(state as Quote['state']);
    return handler.checkPending({
      ...context,
      operation: makePendingOperation(),
      canonicalQuote: quote,
    });
  };
  const rollback = (operation: PreparedOrLaterOperation & MeltMethodMeta<'bolt11'>) =>
    handler.rollback({ ...context, operation } as RollbackContext<'bolt11'>);
  const recover = async (
    options: {
      operation?: ExecutingOperation;
      state?: string;
      response?: QuoteMeltResponse<'bolt11'>;
    } = {},
  ) => {
    if (options.state)
      hooks.checkMeltQuoteState.mockResolvedValueOnce(options.state as Quote['state']);
    if (options.response) hooks.checkMeltQuote.mockResolvedValueOnce(options.response);
    return handler.recoverExecuting({
      ...context,
      operation: options.operation ?? makeExecutingOperation(),
    });
  };

  return {
    handler,
    hooks,
    mocks,
    deps,
    wallet,
    makeQuote,
    makeCanonicalQuote,
    makeInitOperation,
    makePreparedOperation,
    makeExecutingOperation,
    makePendingOperation,
    prepare,
    execute,
    finalize,
    checkPending,
    rollback,
    recover,
  };
}

export type QuoteMeltHandlerHarness = ReturnType<typeof createQuoteMeltHandlerHarness>;
