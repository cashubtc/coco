import { Amount, type Proof, type Wallet } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintAdapter } from '../../infra';
import { MeltBolt11Handler } from '../../infra/handlers/melt/MeltBolt11Handler';
import type { Logger } from '../../logging/Logger';
import type {
  BaseHandlerDeps,
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
  FetchRemoteMeltQuoteContext,
  FinalizeContext,
  PendingContext,
} from '../../operations/melt/MeltMethodHandler';
import type {
  ExecutingMeltOperation,
  InitMeltOperation,
  PendingMeltOperation,
} from '../../operations/melt/MeltOperation';
import type { ProofRepository } from '../../repositories';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';

describe('MeltBolt11Handler adapter contract', () => {
  const mintUrl = 'https://mint.test';
  const invoice = 'lnbc1000n1...';
  const quoteId = 'melt-quote-11';
  const inputProof: Proof = {
    amount: Amount.from(110),
    C: 'C_input',
    id: 'keyset-1',
    secret: 'input-1',
  };

  let handler: MeltBolt11Handler;
  let wallet: Wallet;
  let proofRepository: ProofRepository;
  let proofService: ProofService;
  let mintService: MintService;
  let walletService: WalletService;
  let mintAdapter: MintAdapter;
  let eventBus: EventBus<CoreEvents>;
  let logger: Logger;
  let deps: BaseHandlerDeps;

  const makeInitOperation = (
    overrides: Partial<
      InitMeltOperation & {
        method: 'bolt11';
        methodData: { invoice: string; amountSats?: Amount };
      }
    > = {},
  ): InitMeltOperation & {
    method: 'bolt11';
    methodData: { invoice: string; amountSats?: Amount };
  } => ({
    id: 'operation-11',
    state: 'init',
    mintUrl,
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

  const makeExecutingOperation = (): ExecutingMeltOperation & {
    method: 'bolt11';
    methodData: { invoice: string };
  } => ({
    ...makeInitOperation(),
    state: 'executing',
    quoteId,
    amount: Amount.from(100),
    fee_reserve: Amount.from(10),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(110),
    inputProofSecrets: ['input-1'],
    changeOutputData: { keep: [], send: [] },
  });

  const makePendingOperation = (): PendingMeltOperation & {
    method: 'bolt11';
    methodData: { invoice: string };
  } => ({ ...makeExecutingOperation(), state: 'pending' });

  const buildPrepareContext = (operation = makeInitOperation()): BasePrepareContext<'bolt11'> => ({
    ...deps,
    operation,
    quote: {
      quote: quoteId,
      request: invoice,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      unit: 'sat',
      expiry: 1_700_003_600,
      state: 'UNPAID',
      payment_preimage: null,
    },
    wallet,
  });

  beforeEach(() => {
    handler = new MeltBolt11Handler();
    eventBus = new EventBus<CoreEvents>();
    wallet = {
      createMeltQuoteBolt11: mock(async () => ({
        quote: quoteId,
        request: invoice,
        amount: Amount.from(100),
        fee_reserve: Amount.from(10),
        unit: 'sat',
        expiry: 1_700_003_600,
        state: 'UNPAID',
        payment_preimage: null,
      })),
      getFeesForProofs: mock(() => Amount.zero()),
    } as unknown as Wallet;
    proofRepository = {
      getProofsByOperationId: mock(async () => [inputProof]),
    } as unknown as ProofRepository;
    proofService = {
      selectProofsToSend: mock(async () => [inputProof]),
      reserveProofs: mock(async () => ({ amount: Amount.from(110) })),
      createBlankOutputs: mock(async () => []),
      setProofState: mock(async () => undefined),
      restoreProofsToReady: mock(async () => undefined),
      releaseProofs: mock(async () => undefined),
      unblindAndSaveChangeProofs: mock(async () => undefined),
    } as unknown as ProofService;
    mintService = {} as MintService;
    walletService = {} as WalletService;
    mintAdapter = {
      customMeltBolt11: mock(async () => ({
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-11',
      })),
      checkMeltQuote: mock(async () => ({
        quote: quoteId,
        request: invoice,
        amount: Amount.from(100),
        fee_reserve: Amount.from(10),
        unit: 'sat',
        expiry: 1_700_003_600,
        state: 'PAID',
        change: [],
        payment_preimage: 'preimage-11',
      })),
      checkMeltQuoteState: mock(async () => 'PAID'),
    } as unknown as MintAdapter;
    logger = {
      debug: mock(() => undefined),
      info: mock(() => undefined),
    } as unknown as Logger;
    deps = {
      proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter,
      eventBus,
      logger,
    };
  });

  it('creates amountless BOLT11 quotes through the wallet', async () => {
    const ctx: CreateMeltQuoteContext<'bolt11'> = {
      ...deps,
      mintUrl,
      methodData: { invoice },
      unit: 'sat',
      wallet,
    };

    const quote = await handler.createQuote(ctx);

    expect(wallet.createMeltQuoteBolt11).toHaveBeenCalledWith(invoice, undefined);
    expect(quote.method).toBe('bolt11');
    expect(quote.quoteId).toBe(quoteId);
  });

  it('converts optional BOLT11 quote amounts from sats to millisats', async () => {
    const ctx: CreateMeltQuoteContext<'bolt11'> = {
      ...deps,
      mintUrl,
      methodData: { invoice, amountSats: Amount.from(1_000) },
      unit: 'sat',
      wallet,
    };

    await handler.createQuote(ctx);

    expect(wallet.createMeltQuoteBolt11).toHaveBeenCalledWith(invoice, Amount.from(1_000_000));
  });

  it('fetches remote quotes through the BOLT11 full-quote endpoint', async () => {
    const ctx = {
      ...deps,
      quote: {
        mintUrl,
        method: 'bolt11',
        quoteId,
        quote: quoteId,
      },
    } as unknown as FetchRemoteMeltQuoteContext<'bolt11'>;

    const quote = await handler.fetchRemoteQuote(ctx);

    expect(mintAdapter.checkMeltQuote).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(quote.method).toBe('bolt11');
    expect(quote.quoteId).toBe(quoteId);
  });

  it('prepares melts using the BOLT11 fee reserve', async () => {
    const prepared = await handler.prepare(buildPrepareContext());

    expect(prepared.fee_reserve).toEqual(Amount.from(10));
    expect(proofService.selectProofsToSend).toHaveBeenCalledWith(
      mintUrl,
      { amount: Amount.from(110), unit: 'sat' },
      true,
    );
  });

  it('executes with customMeltBolt11 and maps the returned preimage', async () => {
    const operation = makeExecutingOperation();
    const ctx: ExecuteContext<'bolt11'> = {
      ...deps,
      operation,
      wallet,
      reservedProofs: [inputProof],
    };

    const result = await handler.execute(ctx);

    expect(mintAdapter.customMeltBolt11).toHaveBeenCalledWith(mintUrl, [inputProof], [], quoteId);
    expect(result.status).toBe('PAID');
    if (result.status !== 'PAID') throw new Error('Expected paid result');
    expect(result.finalized.finalizedData).toEqual({ preimage: 'preimage-11' });
  });

  it('checks pending quotes through the BOLT11 state-only endpoint', async () => {
    const ctx: PendingContext<'bolt11'> = {
      ...deps,
      operation: makePendingOperation(),
      wallet,
    };

    const result = await handler.checkPending(ctx);

    expect(mintAdapter.checkMeltQuoteState).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(result).toBe('finalize');
  });

  it('finalizes pending quotes through the BOLT11 full-quote endpoint', async () => {
    const ctx: FinalizeContext<'bolt11'> = {
      ...deps,
      operation: makePendingOperation(),
    };

    const result = await handler.finalize(ctx);

    expect(mintAdapter.checkMeltQuote).toHaveBeenCalledWith(mintUrl, quoteId);
    expect(result.finalizedData).toEqual({ preimage: 'preimage-11' });
  });
});
