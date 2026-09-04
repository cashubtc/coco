import {
  Amount,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedSignature,
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
import type { Wallet } from '@cashu/cashu-ts';

const NOW = 1_700_000_000_000;

export const QUOTE_MELT_FIXTURE = {
  invoice: 'lnbc1000n1...',
  keysetId: 'keyset-1',
  mintUrl: 'https://mint.test',
  quoteId: 'quote-123',
} as const;

type Bolt11Quote = MeltMethodQuoteSnapshot<'bolt11'>;

interface HandlerHooks {
  createRemoteQuote(ctx: CreateMeltQuoteContext<'bolt11'>): Promise<Bolt11Quote>;
  fetchRemoteMeltQuote(ctx: FetchRemoteMeltQuoteContext<'bolt11'>): Promise<Bolt11Quote>;
  executeMelt(
    ctx: ExecuteContext<'bolt11'>,
    proofsToMelt: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<QuoteMeltResponse<'bolt11'>>;
  checkMeltQuote(
    ctx: FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
  ): Promise<QuoteMeltResponse<'bolt11'>>;
  checkMeltQuoteState(
    ctx: PendingContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
  ): Promise<Bolt11Quote['state']>;
  getFeeReserveForQuote(
    quote: Bolt11Quote,
    operation: BasePrepareContext<'bolt11'>['operation'],
  ): Amount;
  buildFinalizedData(
    response: QuoteMeltResponse<'bolt11'>,
  ): FinalizeResult<'bolt11'>['finalizedData'];
}

class HarnessQuoteMeltHandler extends BaseQuoteMeltHandler<'bolt11'> {
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
    proofsToMelt: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ) {
    return this.hooks.executeMelt(ctx, proofsToMelt, changeOutputs, quoteId);
  }

  protected checkMeltQuote(ctx: FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>) {
    return this.hooks.checkMeltQuote(ctx);
  }

  protected checkMeltQuoteState(ctx: PendingContext<'bolt11'> | RecoverExecutingContext<'bolt11'>) {
    return this.hooks.checkMeltQuoteState(ctx);
  }

  protected getFeeReserveForQuote(
    quote: Bolt11Quote,
    operation: BasePrepareContext<'bolt11'>['operation'],
  ) {
    return this.hooks.getFeeReserveForQuote(quote, operation);
  }

  protected buildFinalizedData(response: QuoteMeltResponse<'bolt11'>) {
    return this.hooks.buildFinalizedData(response);
  }
}

export function makeQuoteMeltProof(secret: string, amount = 10, overrides?: Partial<Proof>): Proof {
  return {
    amount: Amount.from(amount),
    C: `C_${secret}`,
    id: QUOTE_MELT_FIXTURE.keysetId,
    secret,
    ...overrides,
  } as Proof;
}

export function makeQuoteMeltCoreProof(
  secret: string,
  amount = 10,
  overrides?: Partial<CoreProof>,
): CoreProof {
  return {
    ...makeQuoteMeltProof(secret, amount),
    mintUrl: QUOTE_MELT_FIXTURE.mintUrl,
    unit: 'sat',
    state: 'ready',
    ...overrides,
  } as CoreProof;
}

export function makeQuoteMeltOutputData(
  keep: Array<{ secret: string; amount?: number }> = [],
  send: Array<{ secret: string; amount?: number }> = [],
): SerializedOutputData {
  const makeOutput = (side: 'keep' | 'send', value: { secret: string; amount?: number }) => ({
    blindedMessage: {
      amount: value.amount ?? 10,
      id: QUOTE_MELT_FIXTURE.keysetId,
      B_: `B_${side}_${value.secret}`,
    },
    blindingFactor: side === 'keep' ? '1234567890abcdef' : 'abcdef1234567890',
    secret: Buffer.from(value.secret).toString('hex'),
  });

  return {
    keep: keep.map((value) => makeOutput('keep', value)),
    send: send.map((value) => makeOutput('send', value)),
  } as SerializedOutputData;
}

export function makeQuoteMeltChange(amount: number, suffix = 'change'): SerializedBlindedSignature {
  return {
    amount: Amount.from(amount),
    id: QUOTE_MELT_FIXTURE.keysetId,
    C_: `C_${suffix}`,
  };
}

export function createQuoteMeltHandlerHarness() {
  const { invoice, keysetId, mintUrl, quoteId } = QUOTE_MELT_FIXTURE;

  const makeQuoteSnapshot = (overrides: Partial<Bolt11Quote> = {}): Bolt11Quote => ({
    quote: quoteId,
    request: invoice,
    amount: Amount.from(100),
    unit: 'sat',
    fee_reserve: Amount.from(10),
    expiry: Math.floor(NOW / 1000) + 3600,
    state: 'UNPAID',
    payment_preimage: null,
    ...overrides,
  });

  const hooks = {
    createRemoteQuote: mock(async (_ctx: CreateMeltQuoteContext<'bolt11'>) => makeQuoteSnapshot()),
    fetchRemoteMeltQuote: mock(async (_ctx: FetchRemoteMeltQuoteContext<'bolt11'>) =>
      makeQuoteSnapshot(),
    ),
    executeMelt: mock(
      async (
        _ctx: ExecuteContext<'bolt11'>,
        _proofsToMelt: Proof[],
        _changeOutputs: OutputDataLike[],
        _quoteId: string,
      ): Promise<QuoteMeltResponse<'bolt11'>> => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-123',
      }),
    ),
    checkMeltQuote: mock(
      async (
        _ctx: FinalizeContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
      ): Promise<QuoteMeltResponse<'bolt11'>> => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-123',
      }),
    ),
    checkMeltQuoteState: mock(
      async (
        _ctx: PendingContext<'bolt11'> | RecoverExecutingContext<'bolt11'>,
      ): Promise<Bolt11Quote['state']> => 'PAID',
    ),
    getFeeReserveForQuote: mock(
      (quote: Bolt11Quote, _operation: BasePrepareContext<'bolt11'>['operation']) =>
        Amount.from(quote.fee_reserve),
    ),
    buildFinalizedData: mock((response: QuoteMeltResponse<'bolt11'>) =>
      response.payment_preimage ? { preimage: response.payment_preimage } : undefined,
    ),
  } satisfies HandlerHooks;

  const walletMocks = {
    getFeesForProofs: mock((_proofs: Proof[]) => Amount.from(1)),
    send: mock(async () => ({
      keep: [makeQuoteMeltProof('keep-1', 50)],
      send: [makeQuoteMeltProof('send-1', 60)],
    })),
  };
  const wallet = walletMocks as unknown as Wallet;

  const proofRepositoryMocks = {
    getProofsByOperationId: mock(
      async (_mintUrl: string, _operationId: string) => [] as CoreProof[],
    ),
  };
  const proofRepository = proofRepositoryMocks as unknown as ProofRepository;

  const proofServiceMocks = {
    selectProofsToSend: mock(async () => [
      makeQuoteMeltProof('input-1', 60),
      makeQuoteMeltProof('input-2', 50),
    ]),
    reserveProofs: mock(async () => ({ amount: Amount.from(110) })),
    createBlankOutputs: mock(async () => [] as OutputDataLike[]),
    createOutputsAndIncrementCounters: mock(async () => ({
      keep: [] as OutputDataLike[],
      send: [] as OutputDataLike[],
      sendAmount: Amount.zero(),
      keepAmount: Amount.zero(),
    })),
    setProofState: mock(async () => undefined),
    saveProofs: mock(async () => undefined),
    restoreProofsToReady: mock(async () => undefined),
    releaseProofs: mock(async () => undefined),
    unblindAndSaveChangeProofs: mock(async () => undefined),
    recoverProofsFromOutputData: mock(async () => [] as CoreProof[]),
  };
  const proofService = proofServiceMocks as unknown as ProofService;

  const walletServiceMocks = {
    getWalletWithActiveKeysetId: mock(async () => ({
      wallet,
      keysetId,
      keyset: { id: keysetId },
      keys: { keys: { 1: 'pubkey' }, id: keysetId },
    })),
    getWallet: mock(async () => wallet),
  };
  const walletService = walletServiceMocks as unknown as WalletService;

  const mintServiceMocks = {
    isTrustedMint: mock(async () => true),
  };
  const mintService = mintServiceMocks as unknown as MintService;

  const mintAdapterMocks = {
    checkProofStates: mock(
      async (): Promise<Array<{ state: 'UNSPENT' | 'SPENT'; Y: string }>> => [
        { state: 'UNSPENT', Y: 'y1' },
      ],
    ),
  };
  const mintAdapter = mintAdapterMocks as unknown as MintAdapter;

  const loggerMocks = {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
  const logger = loggerMocks as unknown as Logger;
  const eventBus = new EventBus<CoreEvents>();

  const deps: BaseHandlerDeps = {
    proofRepository,
    proofService,
    walletService,
    mintService,
    mintAdapter,
    eventBus,
    logger,
  };

  const makeInitOperation = (
    id = 'operation-1',
    overrides: Partial<InitMeltOperation & MeltMethodMeta<'bolt11'>> = {},
  ): InitMeltOperation & MeltMethodMeta<'bolt11'> => ({
    id,
    state: 'init',
    mintUrl,
    method: 'bolt11',
    methodData: { invoice },
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...overrides,
    unit: overrides.unit ?? 'sat',
  });

  const makePreparedOperation = (
    id = 'operation-1',
    overrides: Partial<PreparedMeltOperation & MeltMethodMeta<'bolt11'>> = {},
  ): PreparedMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makeInitOperation(id),
    state: 'prepared',
    quoteId,
    amount: Amount.from(100),
    fee_reserve: Amount.from(10),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(110),
    inputProofSecrets: ['input-1', 'input-2'],
    changeOutputData: makeQuoteMeltOutputData([{ secret: 'change-1' }]),
    ...overrides,
    unit: overrides.unit ?? 'sat',
  });

  const makeExecutingOperation = (
    id = 'operation-1',
    overrides: Partial<ExecutingMeltOperation & MeltMethodMeta<'bolt11'>> = {},
  ): ExecutingMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makePreparedOperation(id),
    state: 'executing',
    ...overrides,
    unit: overrides.unit ?? 'sat',
  });

  const makePendingOperation = (
    id = 'operation-1',
    overrides: Partial<PendingMeltOperation & MeltMethodMeta<'bolt11'>> = {},
  ): PendingMeltOperation & MeltMethodMeta<'bolt11'> => ({
    ...makePreparedOperation(id),
    state: 'pending',
    ...overrides,
    unit: overrides.unit ?? 'sat',
  });

  const makeCanonicalQuote = (
    overrides: Partial<MeltQuote<'bolt11'>> = {},
  ): MeltQuote<'bolt11'> => ({
    ...meltQuoteFromBolt11Response(mintUrl, makeQuoteSnapshot()),
    createdAt: NOW,
    updatedAt: NOW,
    lastObservedRemoteStateAt: NOW,
    ...overrides,
  });

  const buildCreateQuoteContext = (
    methodData: CreateMeltQuoteContext<'bolt11'>['methodData'] = { invoice },
  ): CreateMeltQuoteContext<'bolt11'> => ({
    ...deps,
    mintUrl,
    methodData,
    unit: 'sat',
    wallet,
  });

  const buildFetchRemoteQuoteContext = (
    quote: MeltQuote<'bolt11'> = makeCanonicalQuote(),
  ): FetchRemoteMeltQuoteContext<'bolt11'> => ({ ...deps, quote });

  const buildPrepareContext = (
    operation: InitMeltOperation & MeltMethodMeta<'bolt11'> = makeInitOperation(),
    quote: Partial<Bolt11Quote> = {},
  ): BasePrepareContext<'bolt11'> => ({
    ...deps,
    operation,
    wallet,
    quote: makeQuoteSnapshot(quote),
  });

  const buildExecuteContext = (
    operation: ExecutingMeltOperation & MeltMethodMeta<'bolt11'> = makeExecutingOperation(),
    reservedProofs: Proof[] = [],
  ): ExecuteContext<'bolt11'> => ({ ...deps, operation, wallet, reservedProofs });

  const buildFinalizeContext = (
    operation: PendingMeltOperation & MeltMethodMeta<'bolt11'> = makePendingOperation(),
    canonicalQuote?: MeltQuote<'bolt11'>,
  ): FinalizeContext<'bolt11'> => ({ ...deps, operation, canonicalQuote });

  const buildPendingContext = (
    operation: PendingMeltOperation & MeltMethodMeta<'bolt11'> = makePendingOperation(),
    canonicalQuote?: MeltQuote<'bolt11'>,
  ): PendingContext<'bolt11'> => ({ ...deps, operation, wallet, canonicalQuote });

  const buildRollbackContext = (
    operation: PreparedOrLaterOperation & MeltMethodMeta<'bolt11'> = makePreparedOperation(),
  ): RollbackContext<'bolt11'> => ({ ...deps, operation, wallet });

  const buildRecoverContext = (
    operation: ExecutingMeltOperation & MeltMethodMeta<'bolt11'> = makeExecutingOperation(),
  ): RecoverExecutingContext<'bolt11'> => ({ ...deps, operation, wallet });

  return {
    handler: new HarnessQuoteMeltHandler(hooks),
    hooks,
    mocks: {
      ...walletMocks,
      ...proofRepositoryMocks,
      ...proofServiceMocks,
      ...walletServiceMocks,
      ...mintServiceMocks,
      ...mintAdapterMocks,
      ...loggerMocks,
    },
    wallet,
    deps,
    makeQuoteSnapshot,
    makeCanonicalQuote,
    makeInitOperation,
    makePreparedOperation,
    makeExecutingOperation,
    makePendingOperation,
    buildCreateQuoteContext,
    buildFetchRemoteQuoteContext,
    buildPrepareContext,
    buildExecuteContext,
    buildFinalizeContext,
    buildPendingContext,
    buildRollbackContext,
    buildRecoverContext,
  };
}

export type QuoteMeltHandlerHarness = ReturnType<typeof createQuoteMeltHandlerHarness>;
