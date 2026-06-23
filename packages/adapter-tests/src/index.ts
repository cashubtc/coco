import { Amount } from '@cashu/cashu-ts';
import {
  type Mint,
  type Keyset,
  type CoreProof,
  type Repositories,
  type MeltOperation,
  type MintQuote,
  type MeltQuote,
  type QuoteIdentity,
  type MintQuoteRef,
  type MeltQuoteRef,
  type MintOperation,
  type PaymentRequestReceiveAttempt,
  type PaymentRequestReceiveOperation,
  type ReceiveOperation,
  type SendOperation,
  type AuthSession,
  QuoteIdentityConflictError,
} from '@cashu/coco-core/adapter';

type TransactionFactory<TRepositories extends Repositories = Repositories> = () => Promise<{
  repositories: TRepositories;
  dispose(): Promise<void>;
}>;

type ContractOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: TransactionFactory<TRepositories>;
  testConcurrentRootOperationIsolation?: boolean;
};

export async function runRepositoryTransactionContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('repository transactions contract', () => {
    it('commits all repositories together', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        let committed = false;
        await repositories.withTransaction(async (tx) => {
          await tx.mintRepository.addOrUpdateMint(createDummyMint());
          await tx.keysetRepository.addKeyset(createDummyKeyset());
          await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
          await tx.meltOperationRepository.create(createDummyMeltOperation());
          committed = true;
        });

        expect(committed).toBe(true);
        const stored = await repositories.proofRepository.getAllReadyProofs();
        expect(stored.length).toBeGreaterThan(0);
        const operation = await repositories.meltOperationRepository.getById('melt-op');
        expect(operation).toBeDefined();
        expect(operation?.methodData.amountSats?.toString()).toBe('1');
      } finally {
        await dispose();
      }
    });

    it('rolls back commits on error', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await expectThrows(async () => {
          await repositories.withTransaction(async (tx) => {
            await tx.mintRepository.addOrUpdateMint(createDummyMint());
            throw new Error('boom');
          });
        }, expect);

        const mints = await repositories.mintRepository.getAllMints();
        expect(mints.length).toBe(0);
      } finally {
        await dispose();
      }
    });

    if (options.testConcurrentRootOperationIsolation) {
      it('does not include concurrent root repository writes in active transactions', async () => {
        const { repositories, dispose } = await options.createRepositories();
        try {
          const transactionEntered = createDeferred();
          const releaseTransaction = createDeferred();
          const mintInTransaction = {
            ...createDummyMint(),
            mintUrl: 'https://mint-in-transaction.test',
          };
          const outsideMint = {
            ...createDummyMint(),
            mintUrl: 'https://outside-mint.test',
          };

          const transactionPromise = repositories.withTransaction(async (tx) => {
            await tx.mintRepository.addOrUpdateMint(mintInTransaction);
            transactionEntered.resolve();
            await releaseTransaction.promise;
            throw new Error('rollback transaction');
          });

          await transactionEntered.promise;

          let outsideWriteResolved = false;
          const outsideWritePromise = repositories.mintRepository
            .addOrUpdateMint(outsideMint)
            .then(() => {
              outsideWriteResolved = true;
            });

          await Promise.race([
            outsideWritePromise,
            new Promise((resolve) => setTimeout(resolve, 25)),
          ]);
          expect(outsideWriteResolved).toBe(false);

          releaseTransaction.resolve();
          await expectThrows(() => transactionPromise, expect);
          await outsideWritePromise;

          const mints = await repositories.mintRepository.getAllMints();
          expect(mints).toHaveLength(1);
          expect(mints[0]?.mintUrl).toBe(outsideMint.mintUrl);
        } finally {
          await dispose();
        }
      });
    }
  });
}

export type ContractRunner = {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: Expectation;
};

type Expectation = {
  (value: unknown): ExpectApi;
};

type ExpectApi = {
  toBe(value: unknown): void;
  toHaveLength(len: number): void;
  toBeGreaterThan(value: number): void;
  toBeDefined(): void;
};

async function expectThrows(fn: () => Promise<void>, expect: Expectation) {
  let didThrow = false;
  try {
    await fn();
  } catch (error) {
    didThrow = true;
  }
  expect(didThrow).toBe(true);
}

async function expectThrowsError(
  fn: () => Promise<void>,
  errorClass: Function,
  expect: Expectation,
) {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof errorClass).toBe(true);
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } as const;
}

export function createDummyMint(): Mint {
  return {
    mintUrl: 'https://mint.test',
    name: 'Test Mint',
    mintInfo: {
      name: 'Test Mint',
      pubkey: 'pubkey',
      version: '1.0',
      contact: {},
      nuts: {},
    } as Mint['mintInfo'],
    trusted: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function createDummyKeyset(): Keyset {
  return {
    mintUrl: 'https://mint.test',
    id: 'keyset-id',
    unit: 'sat',
    keypairs: {},
    active: true,
    feePpk: 0,
    updatedAt: 0,
  };
}

export function createDummyProof(overrides?: Partial<CoreProof>): CoreProof {
  return {
    id: 'proof-id',
    amount: Amount.from(1),
    secret: 'secret',
    C: 'C',
    mintUrl: 'https://mint.test',
    unit: 'sat',
    state: 'ready',
    ...overrides,
  } satisfies CoreProof;
}

type InitMeltOperation = Extract<MeltOperation, { state: 'init' }>;

export function createDummyMeltOperation(
  overrides?: Partial<InitMeltOperation>,
): InitMeltOperation {
  return {
    id: 'melt-op',
    state: 'init',
    mintUrl: 'https://mint.test',
    unit: 'sat',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test', amountSats: Amount.from(1) },
    quoteId: 'melt-quote-id',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } satisfies MeltOperation;
}

type PreparedSendOperation = Extract<SendOperation, { state: 'prepared' }>;

function createDummyPreparedSendOperation(
  overrides?: Partial<PreparedSendOperation>,
): PreparedSendOperation {
  return {
    id: 'send-op',
    state: 'prepared',
    mintUrl: 'https://mint.test',
    amount: Amount.from(3),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 0,
    updatedAt: 0,
    needsSwap: false,
    fee: Amount.zero(),
    inputAmount: Amount.from(3),
    inputProofSecrets: ['send-secret-1'],
    ...overrides,
  } satisfies PreparedSendOperation;
}

function createDummySendOperationsByState(unit: string): SendOperation[] {
  const prepared = createDummyPreparedSendOperation({ id: 'send-prepared', unit });
  const token = {
    mint: prepared.mintUrl,
    unit,
    proofs: [{ id: 'keyset-id', amount: Amount.from(3), secret: 'token-secret', C: 'C-token' }],
  };
  return [
    {
      id: 'send-init',
      state: 'init',
      mintUrl: prepared.mintUrl,
      amount: prepared.amount,
      unit,
      method: 'default',
      methodData: {},
      createdAt: 0,
      updatedAt: 0,
    },
    prepared,
    { ...prepared, id: 'send-executing', state: 'executing' },
    { ...prepared, id: 'send-pending', state: 'pending', token },
    { ...prepared, id: 'send-finalized', state: 'finalized', token },
    { ...prepared, id: 'send-rolling-back', state: 'rolling_back', token },
    { ...prepared, id: 'send-rolled-back', state: 'rolled_back', token },
  ] satisfies SendOperation[];
}

type PendingMintOperation = Extract<MintOperation, { state: 'pending' }>;

export function createDummyMintQuote(
  overrides?: Partial<MintQuote<'bolt11'>>,
): MintQuote<'bolt11'> {
  return {
    mintUrl: 'https://mint.test',
    method: 'bolt11',
    quoteId: 'quote-id',
    quote: 'quote-id',
    state: 'UNPAID',
    request: 'lnbc1test',
    amount: Amount.from(3),
    unit: 'sat',
    expiry: 1_730_000_000,
    reusable: false,
    quoteData: {
      amount: Amount.from(3),
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } satisfies MintQuote<'bolt11'>;
}

export function createDummyMeltQuote(
  overrides?: Partial<MeltQuote<'bolt11'>>,
): MeltQuote<'bolt11'> {
  return {
    mintUrl: 'https://mint.test',
    method: 'bolt11',
    quoteId: 'melt-quote-id',
    quote: 'melt-quote-id',
    state: 'UNPAID',
    request: 'lnbc1test',
    amount: Amount.from(3),
    unit: 'sat',
    fee_reserve: Amount.from(1),
    expiry: 1_730_000_000,
    payment_preimage: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } satisfies MeltQuote<'bolt11'>;
}

export function createDummyMintOperation(
  overrides?: Partial<PendingMintOperation>,
): PendingMintOperation {
  return {
    id: 'mint-op',
    state: 'pending',
    mintUrl: 'https://mint.test',
    quoteId: 'quote-id',
    method: 'bolt11',
    methodData: {},
    createdAt: 0,
    updatedAt: 0,
    amount: Amount.from(3),
    unit: 'sat',
    request: 'lnbc1test',
    expiry: 1_730_000_000,
    outputData: { keep: [], send: [] },
    ...overrides,
  } satisfies PendingMintOperation;
}

type InitMintOperation = Extract<MintOperation, { state: 'init' }>;

export function createDummyInitMintOperation(
  overrides?: Partial<InitMintOperation>,
): InitMintOperation {
  return {
    id: 'mint-op-init',
    state: 'init',
    mintUrl: 'https://mint.test',
    quoteId: 'mint-quote-id',
    method: 'bolt11',
    methodData: {},
    createdAt: 0,
    updatedAt: 0,
    amount: Amount.from(3),
    unit: 'sat',
    ...overrides,
  } satisfies InitMintOperation;
}

export function createDummyReceiveOperation(): ReceiveOperation {
  return {
    id: 'receive-op',
    state: 'init',
    mintUrl: 'https://mint.test',
    unit: 'sat',
    amount: Amount.from(3),
    inputProofs: [
      { id: 'keyset-id', amount: Amount.from(1), secret: 'receive-secret-1', C: 'C1' },
      { id: 'keyset-id', amount: Amount.from(2), secret: 'receive-secret-2', C: 'C2' },
    ],
    createdAt: 0,
    updatedAt: 0,
  } satisfies ReceiveOperation;
}

export function createDummyPaymentRequestReceiveOperation(
  overrides?: Partial<PaymentRequestReceiveOperation>,
): PaymentRequestReceiveOperation {
  return {
    id: 'payment-request-receive-op',
    requestId: 'request-id',
    encodedRequest: 'CREQB1TEST',
    state: 'active',
    transport: 'inband',
    amount: Amount.from(100),
    unit: 'sat',
    mints: ['https://mint.test'],
    singleUse: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function createDummyPaymentRequestReceiveAttempt(
  overrides?: Partial<PaymentRequestReceiveAttempt>,
): PaymentRequestReceiveAttempt {
  return {
    id: 'payment-request-receive-attempt',
    requestOperationId: 'payment-request-receive-op',
    requestId: 'request-id',
    transport: 'inband',
    transportMessageId: 'message-id',
    payloadHash: 'payload-hash',
    mintUrl: 'https://mint.test',
    unit: 'sat',
    grossAmount: Amount.from(100),
    state: 'received',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function createDummyAuthSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    mintUrl: 'https://mint.test',
    accessToken: 'access-token-123',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

export async function runMintOperationRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('MintOperationRepository contract', () => {
    it('round-trips init mint operation quote ids', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = createDummyInitMintOperation({ quoteId: 'init-mint-quote' });
        await repositories.mintOperationRepository.create(operation);

        const stored = await repositories.mintOperationRepository.getById(operation.id);

        expect(stored).toBeDefined();
        expect(stored!.state).toBe('init');
        expect(stored!.quoteId).toBe('init-mint-quote');
      } finally {
        await dispose();
      }
    });

    it('preserves null quote expiries for pending operations', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = createDummyMintOperation({ expiry: null });
        await repositories.mintOperationRepository.create(operation);

        const stored = await repositories.mintOperationRepository.getById(operation.id);
        const pending = await repositories.mintOperationRepository.getPending();

        expect(stored).toBeDefined();
        expect(pending).toHaveLength(1);
        if (!stored || stored.state !== 'pending' || pending[0]?.state !== 'pending') {
          throw new Error('Expected pending mint operations');
        }
        expect(stored.expiry).toBe(null);
        expect(pending[0].expiry).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('returns only pending and executing work from getPending', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const pending = createDummyMintOperation({
          id: 'mint-op-pending',
          quoteId: 'quote-pending',
          createdAt: 1_000,
        });
        const executing = {
          ...createDummyMintOperation({
            id: 'mint-op-executing',
            quoteId: 'quote-executing',
            createdAt: 2_000,
          }),
          state: 'executing',
        } satisfies MintOperation;
        const finalized = {
          ...createDummyMintOperation({
            id: 'mint-op-finalized',
            quoteId: 'quote-finalized',
            createdAt: 3_000,
          }),
          state: 'finalized',
        } satisfies MintOperation;

        await repositories.mintOperationRepository.create(pending);
        await repositories.mintOperationRepository.create(executing);
        await repositories.mintOperationRepository.create(finalized);

        const inFlight = await repositories.mintOperationRepository.getPending();

        expect(inFlight).toHaveLength(2);
        expect(
          inFlight
            .map((operation) => operation.state)
            .sort()
            .join(','),
        ).toBe('executing,pending');
        expect(
          inFlight
            .map((operation) => operation.id)
            .sort()
            .join(','),
        ).toBe('mint-op-executing,mint-op-pending');
      } finally {
        await dispose();
      }
    });

    it('returns sibling mint operations by full quote identity in deterministic order', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const first = createDummyMintOperation({
          id: 'mint-op-a',
          quoteId: 'shared-quote',
          createdAt: 2_000,
        });
        const second = createDummyMintOperation({
          id: 'mint-op-b',
          quoteId: 'shared-quote',
          createdAt: 1_000,
        });
        const otherMethod = createDummyMintOperation({
          id: 'mint-op-other',
          quoteId: 'shared-quote',
          method: 'bolt11',
          mintUrl: 'https://other-mint.test',
        });

        await repositories.mintOperationRepository.create(first);
        await repositories.mintOperationRepository.create(second);
        await repositories.mintOperationRepository.create(otherMethod);

        const stored = await repositories.mintOperationRepository.getByQuoteId(
          'https://mint.test',
          'bolt11',
          'shared-quote',
        );

        expect(stored).toHaveLength(2);
        expect(stored[0]?.id).toBe('mint-op-b');
        expect(stored[1]?.id).toBe('mint-op-a');
      } finally {
        await dispose();
      }
    });

    it('persists canonical mint quotes by full quote identity', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote = createDummyMintQuote({
          mintUrl: 'https://mint.test/',
          quoteId: 'canonical-quote',
          quote: 'canonical-quote',
          lastObservedRemoteState: 'UNPAID',
          lastObservedRemoteStateAt: 10,
        });
        await repositories.mintQuoteRepository.upsertMintQuote(quote);
        await repositories.mintQuoteRepository.setMintQuoteState(
          'https://mint.test',
          'bolt11',
          'canonical-quote',
          'PAID',
          20,
        );

        const stored = await repositories.mintQuoteRepository.getMintQuote(
          'https://mint.test',
          'bolt11',
          'canonical-quote',
        );

        expect(stored).toBeDefined();
        expect(stored!.mintUrl).toBe('https://mint.test');
        expect(stored!.method).toBe('bolt11');
        expect(stored!.quoteId).toBe('canonical-quote');
        expect(stored!.reusable).toBe(false);
        if (stored!.method !== 'bolt11') {
          throw new Error(`Expected bolt11 quote, got ${stored!.method}`);
        }
        expect(stored!.state).toBe('PAID');
        expect(stored!.quoteData.amount.equals(Amount.from(3))).toBe(true);
        expect(stored!.lastObservedRemoteState).toBe('PAID');
        expect(stored!.lastObservedRemoteStateAt).toBe(20);
      } finally {
        await dispose();
      }
    });

    it('looks up canonical mint quotes by identity without method', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote = createDummyMintQuote({
          mintUrl: 'https://mint.test/',
          quoteId: 'identity-mint-quote',
          quote: 'identity-mint-quote',
        });
        const ref: MintQuoteRef = quote;
        const identity: QuoteIdentity = ref;
        await repositories.mintQuoteRepository.upsertMintQuote(quote);

        const stored = await repositories.mintQuoteRepository.getMintQuoteById(identity);
        const absent = await repositories.mintQuoteRepository.getMintQuoteById({
          mintUrl: 'https://mint.test',
          quoteId: 'missing-mint-quote',
        });

        expect(stored).toBeDefined();
        expect(stored!.method).toBe('bolt11');
        expect(stored!.quoteId).toBe('identity-mint-quote');
        expect(absent).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('rejects same-mint mint quote identity collisions across methods', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote = createDummyMintQuote({
          mintUrl: 'https://mint.test/',
          quoteId: 'colliding-mint-quote',
          quote: 'colliding-mint-quote',
        });
        const collidingQuote: MintQuote<'bolt12'> = {
          mintUrl: 'https://mint.test',
          method: 'bolt12',
          quoteId: 'colliding-mint-quote',
          quote: 'colliding-mint-quote',
          request: 'lno1collision',
          unit: 'sat',
          expiry: 1_730_000_000,
          pubkey: '02'.padEnd(66, '4'),
          reusable: true,
          quoteData: {
            pubkey: '02'.padEnd(66, '4'),
            amountPaid: Amount.from(0),
            amountIssued: Amount.from(0),
          },
          lastObservedRemoteStateAt: 20,
          createdAt: 0,
          updatedAt: 0,
        };

        await repositories.mintQuoteRepository.upsertMintQuote(quote);
        await expectThrowsError(
          () => repositories.mintQuoteRepository.upsertMintQuote(collidingQuote),
          QuoteIdentityConflictError,
          expect,
        );

        const exact = await repositories.mintQuoteRepository.getMintQuote(
          'https://mint.test',
          'bolt11',
          'colliding-mint-quote',
        );
        const missingSibling = await repositories.mintQuoteRepository.getMintQuote(
          'https://mint.test',
          'bolt12',
          'colliding-mint-quote',
        );
        expect(exact).toBeDefined();
        expect(missingSibling).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('keeps mint and melt quote identity namespaces separate', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.mintQuoteRepository.upsertMintQuote(
          createDummyMintQuote({
            quoteId: 'shared-cross-kind-quote',
            quote: 'shared-cross-kind-quote',
          }),
        );
        await repositories.meltQuoteRepository.upsertMeltQuote(
          createDummyMeltQuote({
            quoteId: 'shared-cross-kind-quote',
            quote: 'shared-cross-kind-quote',
          }),
        );

        const mintQuote = await repositories.mintQuoteRepository.getMintQuoteById({
          mintUrl: 'https://mint.test',
          quoteId: 'shared-cross-kind-quote',
        });
        const meltQuote = await repositories.meltQuoteRepository.getMeltQuoteById({
          mintUrl: 'https://mint.test',
          quoteId: 'shared-cross-kind-quote',
        });

        expect(mintQuote).toBeDefined();
        expect(meltQuote).toBeDefined();
        expect(mintQuote!.quoteId).toBe(meltQuote!.quoteId);
      } finally {
        await dispose();
      }
    });

    it('persists reusable onchain mint quote data', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.mintQuoteRepository.upsertMintQuote({
          mintUrl: 'https://mint.test/',
          method: 'onchain',
          quoteId: 'onchain-quote',
          quote: 'onchain-quote',
          request: 'bc1qdeposit',
          unit: 'sat',
          expiry: 1_730_000_000,
          pubkey: '02'.padEnd(66, '1'),
          reusable: true,
          quoteData: {
            pubkey: '02'.padEnd(66, '1'),
            amountPaid: Amount.from(21),
            amountIssued: Amount.from(8),
          },
          lastObservedRemoteStateAt: 20,
          createdAt: 0,
          updatedAt: 0,
        });

        const stored = await repositories.mintQuoteRepository.getMintQuote(
          'https://mint.test',
          'onchain',
          'onchain-quote',
        );

        expect(stored).toBeDefined();
        if (!stored) {
          throw new Error('Expected onchain quote to be stored');
        }
        expect(stored.method).toBe('onchain');
        if (stored.method !== 'onchain') {
          throw new Error(`Expected onchain quote, got ${stored.method}`);
        }
        expect(stored.reusable).toBe(true);
        expect(stored.quoteData.pubkey).toBe('02'.padEnd(66, '1'));
        expect(stored.quoteData.amountPaid.equals(Amount.from(21))).toBe(true);
        expect(stored.quoteData.amountIssued.equals(Amount.from(8))).toBe(true);
      } finally {
        await dispose();
      }
    });

    it('persists reusable BOLT12 mint quote data', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.mintQuoteRepository.upsertMintQuote({
          mintUrl: 'https://mint.test/',
          method: 'bolt12',
          quoteId: 'bolt12-quote',
          quote: 'bolt12-quote',
          request: 'lno1offer',
          amount: Amount.from(12),
          unit: 'sat',
          expiry: 1_730_000_000,
          pubkey: '02'.padEnd(66, '2'),
          reusable: true,
          quoteData: {
            pubkey: '02'.padEnd(66, '2'),
            amount: Amount.from(12),
            amountPaid: Amount.from(21),
            amountIssued: Amount.from(8),
          },
          lastObservedRemoteStateAt: 20,
          createdAt: 0,
          updatedAt: 0,
        });
        await repositories.mintQuoteRepository.upsertMintQuote({
          mintUrl: 'https://mint.test/',
          method: 'bolt12',
          quoteId: 'bolt12-amountless-quote',
          quote: 'bolt12-amountless-quote',
          request: 'lno1amountless',
          unit: 'sat',
          expiry: 1_730_000_000,
          pubkey: '02'.padEnd(66, '3'),
          reusable: true,
          quoteData: {
            pubkey: '02'.padEnd(66, '3'),
            amountPaid: Amount.from(5),
            amountIssued: Amount.from(0),
          },
          lastObservedRemoteStateAt: 20,
          createdAt: 0,
          updatedAt: 0,
        });

        const stored = await repositories.mintQuoteRepository.getMintQuote(
          'https://mint.test',
          'bolt12',
          'bolt12-quote',
        );
        const amountless = await repositories.mintQuoteRepository.getMintQuote(
          'https://mint.test',
          'bolt12',
          'bolt12-amountless-quote',
        );

        expect(stored).toBeDefined();
        if (!stored) {
          throw new Error('Expected BOLT12 quote to be stored');
        }
        expect(stored.method).toBe('bolt12');
        if (stored.method !== 'bolt12') {
          throw new Error(`Expected BOLT12 quote, got ${stored.method}`);
        }
        expect(stored.reusable).toBe(true);
        expect(stored.amount?.equals(Amount.from(12))).toBe(true);
        expect(stored.quoteData.pubkey).toBe('02'.padEnd(66, '2'));
        expect(stored.quoteData.amount?.equals(Amount.from(12))).toBe(true);
        expect(stored.quoteData.amountPaid.equals(Amount.from(21))).toBe(true);
        expect(stored.quoteData.amountIssued.equals(Amount.from(8))).toBe(true);

        expect(amountless).toBeDefined();
        if (!amountless) {
          throw new Error('Expected amountless BOLT12 quote to be stored');
        }
        expect(amountless.method).toBe('bolt12');
        if (amountless.method !== 'bolt12') {
          throw new Error(`Expected amountless BOLT12 quote, got ${amountless.method}`);
        }
        expect(amountless.reusable).toBe(true);
        expect(amountless.amount).toBe(undefined);
        expect(amountless.quoteData.amount).toBe(undefined);
        expect(amountless.quoteData.pubkey).toBe('02'.padEnd(66, '3'));
        expect(amountless.quoteData.amountPaid.equals(Amount.from(5))).toBe(true);
        expect(amountless.quoteData.amountIssued.equals(Amount.from(0))).toBe(true);
      } finally {
        await dispose();
      }
    });
  });
}

export async function runMeltQuoteRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('MeltQuoteRepository contract', () => {
    it('persists canonical melt quotes by full quote identity', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote = createDummyMeltQuote({
          mintUrl: 'https://mint.test/',
          quoteId: 'canonical-melt-quote',
          quote: 'canonical-melt-quote',
          state: 'PENDING',
          lastObservedRemoteState: 'PENDING',
          lastObservedRemoteStateAt: 20,
        });

        await repositories.meltQuoteRepository.upsertMeltQuote(quote);

        const stored = await repositories.meltQuoteRepository.getMeltQuote(
          'https://mint.test',
          'bolt11',
          'canonical-melt-quote',
        );

        expect(stored).toBeDefined();
        expect(stored!.mintUrl).toBe('https://mint.test');
        expect(stored!.method).toBe('bolt11');
        expect(stored!.quoteId).toBe('canonical-melt-quote');
        expect(stored!.state).toBe('PENDING');
        expect(stored!.lastObservedRemoteState).toBe('PENDING');
        expect(stored!.lastObservedRemoteStateAt).toBe(20);
      } finally {
        await dispose();
      }
    });

    it('looks up canonical melt quotes by identity without method', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote = createDummyMeltQuote({
          mintUrl: 'https://mint.test/',
          quoteId: 'identity-melt-quote',
          quote: 'identity-melt-quote',
        });
        const ref: MeltQuoteRef = quote;
        const identity: QuoteIdentity = ref;
        await repositories.meltQuoteRepository.upsertMeltQuote(quote);

        const stored = await repositories.meltQuoteRepository.getMeltQuoteById(identity);
        const absent = await repositories.meltQuoteRepository.getMeltQuoteById({
          mintUrl: 'https://mint.test',
          quoteId: 'missing-melt-quote',
        });

        expect(stored).toBeDefined();
        expect(stored!.method).toBe('bolt11');
        expect(stored!.quoteId).toBe('identity-melt-quote');
        expect(absent).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('rejects same-mint melt quote identity collisions across methods', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote = createDummyMeltQuote({
          mintUrl: 'https://mint.test/',
          quoteId: 'colliding-melt-quote',
          quote: 'colliding-melt-quote',
        });
        const collidingQuote = {
          ...createDummyMeltQuote({
            mintUrl: 'https://mint.test',
            quoteId: 'colliding-melt-quote',
            quote: 'colliding-melt-quote',
            request: 'lno1collision',
          }),
          method: 'bolt12' as const,
        } satisfies MeltQuote<'bolt12'>;

        await repositories.meltQuoteRepository.upsertMeltQuote(quote);
        await expectThrowsError(
          () => repositories.meltQuoteRepository.upsertMeltQuote(collidingQuote),
          QuoteIdentityConflictError,
          expect,
        );

        const exact = await repositories.meltQuoteRepository.getMeltQuote(
          'https://mint.test',
          'bolt11',
          'colliding-melt-quote',
        );
        const missingSibling = await repositories.meltQuoteRepository.getMeltQuote(
          'https://mint.test',
          'bolt12',
          'colliding-melt-quote',
        );
        expect(exact).toBeDefined();
        expect(missingSibling).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('lists only active melt quotes, optionally scoped by method', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.meltQuoteRepository.upsertMeltQuote(
          createDummyMeltQuote({ quoteId: 'unpaid', quote: 'unpaid', state: 'UNPAID' }),
        );
        await repositories.meltQuoteRepository.upsertMeltQuote(
          createDummyMeltQuote({ quoteId: 'pending', quote: 'pending', state: 'PENDING' }),
        );
        await repositories.meltQuoteRepository.upsertMeltQuote(
          createDummyMeltQuote({ quoteId: 'paid', quote: 'paid', state: 'PAID' }),
        );

        const pending = await repositories.meltQuoteRepository.getPendingMeltQuotes('bolt11');

        expect(pending).toHaveLength(2);
        expect(pending.some((quote) => quote.quoteId === 'paid')).toBe(false);
      } finally {
        await dispose();
      }
    });

    it('persists onchain melt quote fee options and outpoint', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const quote: MeltQuote<'onchain'> = {
          mintUrl: 'https://mint.test/',
          method: 'onchain',
          quoteId: 'onchain-melt-quote',
          quote: 'onchain-melt-quote',
          state: 'PENDING',
          request: 'bc1ptest',
          amount: Amount.from(21),
          unit: 'sat',
          fee_options: [
            {
              fee_index: 7,
              fee_reserve: Amount.from(2),
              estimated_blocks: 3,
            },
          ],
          outpoint: 'txid:0',
          expiry: 1_730_000_000,
          createdAt: 0,
          updatedAt: 0,
        };

        await repositories.meltQuoteRepository.upsertMeltQuote(quote);

        const stored = await repositories.meltQuoteRepository.getMeltQuote(
          'https://mint.test',
          'onchain',
          'onchain-melt-quote',
        );

        expect(stored?.method).toBe('onchain');
        if (stored?.method !== 'onchain') {
          throw new Error('Expected onchain melt quote');
        }
        expect(stored.fee_options).toHaveLength(1);
        expect(stored.fee_options[0]!.fee_index).toBe(7);
        expect(stored.fee_options[0]!.fee_reserve.equals(Amount.from(2))).toBe(true);
        expect(stored.fee_options[0]!.estimated_blocks).toBe(3);
        expect(stored.outpoint).toBe('txid:0');
      } finally {
        await dispose();
      }
    });
  });
}

export async function runReceiveOperationRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('ReceiveOperationRepository contract', () => {
    it('rehydrates persisted input proof amounts', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = createDummyReceiveOperation();
        await repositories.receiveOperationRepository.create(operation);

        const stored = await repositories.receiveOperationRepository.getById(operation.id);

        expect(stored).toBeDefined();
        expect(stored!.inputProofs).toHaveLength(2);
        expect(stored!.inputProofs[0]!.amount.equals(Amount.from(1))).toBe(true);
        expect(stored!.inputProofs[1]!.amount.equals(Amount.from(2))).toBe(true);
      } finally {
        await dispose();
      }
    });

    it('creates prepared operations with serialized fees', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = {
          ...createDummyReceiveOperation(),
          id: 'receive-op-prepared',
          state: 'prepared',
          fee: Amount.from(1),
          outputData: { keep: [], send: [] },
        } satisfies ReceiveOperation;
        await repositories.receiveOperationRepository.create(operation);

        const stored = await repositories.receiveOperationRepository.getById(operation.id);

        expect(stored).toBeDefined();
        expect(stored!.state).toBe('prepared');
        if (stored!.state === 'prepared') {
          expect(stored!.fee.equals(Amount.from(1))).toBe(true);
        }
      } finally {
        await dispose();
      }
    });

    it('round-trips optional receive operation source metadata', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = createDummyReceiveOperation();
        operation.source = {
          type: 'payment-request',
          requestOperationId: 'request-op',
          attemptId: 'attempt-id',
          transport: 'inband',
        };
        await repositories.receiveOperationRepository.create(operation);

        const stored = await repositories.receiveOperationRepository.getById(operation.id);
        const byAttempt =
          await repositories.receiveOperationRepository.getByPaymentRequestAttemptId('attempt-id');

        expect(stored).toBeDefined();
        expect(byAttempt?.id).toBe(operation.id);
        expect(stored!.source?.type).toBe('payment-request');
        if (stored!.source?.type === 'payment-request') {
          expect(stored!.source.requestOperationId).toBe('request-op');
          expect(stored!.source.attemptId).toBe('attempt-id');
        }
      } finally {
        await dispose();
      }
    });
  });
}

export async function runPaymentRequestReceiveRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('PaymentRequestReceiveRepository contract', () => {
    it('round-trips active operations and attempts', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = createDummyPaymentRequestReceiveOperation();
        const attempt = createDummyPaymentRequestReceiveAttempt();

        await repositories.paymentRequestReceiveOperationRepository.create(operation);
        await repositories.paymentRequestReceiveAttemptRepository.create(attempt);

        const active =
          await repositories.paymentRequestReceiveOperationRepository.getActiveByRequestId(
            'request-id',
          );
        const attempts =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestOperationId(
            operation.id,
          );
        const byPayload =
          await repositories.paymentRequestReceiveAttemptRepository.getByPayloadHash(
            operation.id,
            attempt.payloadHash,
          );

        expect(active).toHaveLength(1);
        expect(attempts).toHaveLength(1);
        expect(byPayload).toBeDefined();
        expect(active[0]!.amount.equals(Amount.from(100))).toBe(true);
        expect(attempts[0]!.grossAmount.equals(Amount.from(100))).toBe(true);
      } finally {
        await dispose();
      }
    });

    it('enforces idempotency by request operation and payload hash', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.paymentRequestReceiveAttemptRepository.create(
          createDummyPaymentRequestReceiveAttempt(),
        );

        let duplicateRejected = false;
        try {
          await repositories.paymentRequestReceiveAttemptRepository.create(
            createDummyPaymentRequestReceiveAttempt({ id: 'duplicate-attempt' }),
          );
        } catch {
          duplicateRejected = true;
        }

        expect(duplicateRejected).toBe(true);
      } finally {
        await dispose();
      }
    });

    it('enforces idempotency by transport message id', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.paymentRequestReceiveAttemptRepository.create(
          createDummyPaymentRequestReceiveAttempt(),
        );

        let duplicateRejected = false;
        try {
          await repositories.paymentRequestReceiveAttemptRepository.create(
            createDummyPaymentRequestReceiveAttempt({
              id: 'duplicate-message-attempt',
              payloadHash: 'different-payload-hash',
            }),
          );
        } catch {
          duplicateRejected = true;
        }

        expect(duplicateRejected).toBe(true);
      } finally {
        await dispose();
      }
    });

    it('looks up attempts by transport message id and child receive id', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const attempt = createDummyPaymentRequestReceiveAttempt({
          receiveOperationId: 'receive-op-id',
        });
        await repositories.paymentRequestReceiveAttemptRepository.create(attempt);

        const byMessage =
          await repositories.paymentRequestReceiveAttemptRepository.getByTransportMessageId(
            'message-id',
          );
        const byReceive =
          await repositories.paymentRequestReceiveAttemptRepository.getByReceiveOperationId(
            'receive-op-id',
          );

        expect(byMessage).toBeDefined();
        expect(byReceive).toBeDefined();
        expect(byMessage!.id).toBe(attempt.id);
        expect(byReceive!.id).toBe(attempt.id);
      } finally {
        await dispose();
      }
    });

    it('prefers finalized attempts for request id and payload hash lookups', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.paymentRequestReceiveAttemptRepository.create(
          createDummyPaymentRequestReceiveAttempt({
            id: 'rejected-attempt',
            requestOperationId: 'old-operation',
            transportMessageId: undefined,
            state: 'rejected',
            error: 'below requested amount',
          }),
        );
        await repositories.paymentRequestReceiveAttemptRepository.create(
          createDummyPaymentRequestReceiveAttempt({
            id: 'finalized-attempt',
            requestOperationId: 'new-operation',
            transportMessageId: undefined,
            state: 'finalized',
          }),
        );

        const byRequestPayload =
          await repositories.paymentRequestReceiveAttemptRepository.getByRequestIdAndPayloadHash(
            'request-id',
            'payload-hash',
          );

        expect(byRequestPayload?.id).toBe('finalized-attempt');
      } finally {
        await dispose();
      }
    });
  });
}

export async function runSendOperationRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('SendOperationRepository contract', () => {
    it('round-trips custom-unit send operations in every state', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operations = createDummySendOperationsByState('usd');
        for (const operation of operations) {
          await repositories.sendOperationRepository.create(operation);
        }

        for (const operation of operations) {
          const stored = await repositories.sendOperationRepository.getById(operation.id);
          expect(stored).toBeDefined();
          expect(stored!.unit).toBe('usd');
        }

        const pending = await repositories.sendOperationRepository.getByState('pending');
        expect(pending).toHaveLength(1);
        expect(pending[0]!.unit).toBe('usd');

        const inFlight = await repositories.sendOperationRepository.getPending();
        expect(inFlight).toHaveLength(3);
        for (const operation of inFlight) {
          expect(operation.unit).toBe('usd');
        }
      } finally {
        await dispose();
      }
    });
  });
}

export async function runMeltOperationRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('MeltOperationRepository contract', () => {
    it('round-trips custom-unit init melt operations', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const operation = createDummyMeltOperation({
          quoteId: 'init-melt-quote',
          unit: 'usd',
        });
        await repositories.meltOperationRepository.create(operation);

        const stored = await repositories.meltOperationRepository.getById(operation.id);

        expect(stored).toBeDefined();
        expect(stored!.state).toBe('init');
        expect(stored!.quoteId).toBe('init-melt-quote');
        expect(stored!.unit).toBe('usd');
      } finally {
        await dispose();
      }
    });

    it('rejects duplicate quote-bound melt operations', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.meltOperationRepository.create(
          createDummyMeltOperation({ id: 'melt-op-1', quoteId: 'shared-melt-quote' }),
        );

        await expectThrows(
          () =>
            repositories.meltOperationRepository.create(
              createDummyMeltOperation({ id: 'melt-op-2', quoteId: 'shared-melt-quote' }),
            ),
          expect,
        );
      } finally {
        await dispose();
      }
    });

    it('rejects updates that would duplicate a melt quote binding', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.meltOperationRepository.create(
          createDummyMeltOperation({ id: 'melt-op-1', quoteId: 'shared-melt-quote' }),
        );
        await repositories.meltOperationRepository.create(
          createDummyMeltOperation({ id: 'melt-op-2', quoteId: 'other-melt-quote' }),
        );

        await expectThrows(
          () =>
            repositories.meltOperationRepository.update(
              createDummyMeltOperation({ id: 'melt-op-2', quoteId: 'shared-melt-quote' }),
            ),
          expect,
        );
      } finally {
        await dispose();
      }
    });
  });
}

export async function runAuthSessionRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('AuthSessionRepository contract', () => {
    it('saveSession + getSession round-trip', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repo = repositories.authSessionRepository;
        const session = createDummyAuthSession();
        await repo.saveSession(session);
        const result = await repo.getSession(session.mintUrl);
        expect(result).toBeDefined();
        expect(result!.mintUrl).toBe(session.mintUrl);
        expect(result!.accessToken).toBe(session.accessToken);
        expect(result!.expiresAt).toBe(session.expiresAt);
      } finally {
        await dispose();
      }
    });

    it('getSession returns null for unknown mintUrl', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const result = await repositories.authSessionRepository.getSession('https://unknown.test');
        expect(result).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('saveSession upserts on same mintUrl', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repo = repositories.authSessionRepository;
        const session = createDummyAuthSession();
        await repo.saveSession(session);

        const updated = { ...session, accessToken: 'new-token-456' };
        await repo.saveSession(updated);

        const result = await repo.getSession(session.mintUrl);
        expect(result).toBeDefined();
        expect(result!.accessToken).toBe('new-token-456');

        const all = await repo.getAllSessions();
        expect(all).toHaveLength(1);
      } finally {
        await dispose();
      }
    });

    it('deleteSession removes session', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repo = repositories.authSessionRepository;
        const session = createDummyAuthSession();
        await repo.saveSession(session);
        await repo.deleteSession(session.mintUrl);
        const result = await repo.getSession(session.mintUrl);
        expect(result).toBe(null);
      } finally {
        await dispose();
      }
    });

    it('getAllSessions returns all stored sessions', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repo = repositories.authSessionRepository;
        await repo.saveSession(createDummyAuthSession({ mintUrl: 'https://mint-a.test' }));
        await repo.saveSession(createDummyAuthSession({ mintUrl: 'https://mint-b.test' }));
        await repo.saveSession(createDummyAuthSession({ mintUrl: 'https://mint-c.test' }));

        const all = await repo.getAllSessions();
        expect(all).toHaveLength(3);
      } finally {
        await dispose();
      }
    });

    it('persists optional fields (refreshToken, scope, batPool)', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const repo = repositories.authSessionRepository;
        const session = createDummyAuthSession({
          refreshToken: 'refresh-xyz',
          scope: 'read write',
          batPool: [
            { id: 'proof-1', amount: Amount.from(1), secret: 's1', C: 'C1' },
            { id: 'proof-2', amount: Amount.from(2), secret: 's2', C: 'C2' },
          ] as AuthSession['batPool'],
        });
        await repo.saveSession(session);

        const result = await repo.getSession(session.mintUrl);
        expect(result).toBeDefined();
        expect(result!.refreshToken).toBe('refresh-xyz');
        expect(result!.scope).toBe('read write');
        expect(result!.batPool).toBeDefined();
        expect(result!.batPool!).toHaveLength(2);
        expect(result!.batPool![0]!.amount.equals(Amount.from(1))).toBe(true);
        expect(result!.batPool![1]!.amount.equals(Amount.from(2))).toBe(true);
      } finally {
        await dispose();
      }
    });
  });
}

export async function runProofRepositoryContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('ProofRepository contract', () => {
    it('returns matches for a mint', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.proofRepository.saveProofs('https://mint.test', [
          createDummyProof({ secret: 'secret-1' }),
          createDummyProof({ secret: 'secret-2', C: 'C2' }),
        ]);

        const proofs = await repositories.proofRepository.getProofsBySecrets('https://mint.test', [
          'secret-1',
          'secret-2',
        ]);

        expect(proofs).toHaveLength(2);
      } finally {
        await dispose();
      }
    });

    it('ignores missing secrets', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.proofRepository.saveProofs('https://mint.test', [
          createDummyProof({ secret: 'secret-1' }),
        ]);

        const proofs = await repositories.proofRepository.getProofsBySecrets('https://mint.test', [
          'secret-1',
          'missing-secret',
        ]);

        expect(proofs).toHaveLength(1);
      } finally {
        await dispose();
      }
    });

    it('does not return proofs from another mint', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.proofRepository.saveProofs('https://mint.test', [
          createDummyProof({ secret: 'shared-secret' }),
        ]);
        await repositories.proofRepository.saveProofs('https://other-mint.test', [
          createDummyProof({ mintUrl: 'https://other-mint.test', secret: 'shared-secret' }),
        ]);

        const proofs = await repositories.proofRepository.getProofsBySecrets('https://mint.test', [
          'shared-secret',
        ]);

        expect(proofs).toHaveLength(1);
        expect(proofs[0]?.mintUrl).toBe('https://mint.test');
      } finally {
        await dispose();
      }
    });

    it('does not duplicate returned proofs for repeated secrets', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.proofRepository.saveProofs('https://mint.test', [
          createDummyProof({ secret: 'secret-1' }),
        ]);

        const proofs = await repositories.proofRepository.getProofsBySecrets('https://mint.test', [
          'secret-1',
          'secret-1',
          'secret-1',
        ]);

        expect(proofs).toHaveLength(1);
      } finally {
        await dispose();
      }
    });

    it('returns large secret batches without hitting adapter query limits', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const secrets = Array.from({ length: 1100 }, (_, index) => `secret-${index}`);
        await repositories.proofRepository.saveProofs(
          'https://mint.test',
          secrets.map((secret, index) =>
            createDummyProof({
              secret,
              C: `C-${index}`,
            }),
          ),
        );

        const proofs = await repositories.proofRepository.getProofsBySecrets(
          'https://mint.test',
          secrets,
        );

        expect(proofs).toHaveLength(secrets.length);
        expect(new Set(proofs.map((proof) => proof.secret)).size).toBe(secrets.length);
      } finally {
        await dispose();
      }
    });

    it('round-trips proof units and filters ready proofs by unit', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await repositories.proofRepository.saveProofs('https://mint.test', [
          createDummyProof({ secret: 'sat-secret', C: 'C-sat', unit: 'sat' }),
          createDummyProof({ secret: 'usd-secret', C: 'C-usd', unit: 'USD' }),
        ]);

        const satProofs = await repositories.proofRepository.getReadyProofs('https://mint.test', {
          unit: 'sat',
        });
        const usdProofs = await repositories.proofRepository.getAvailableProofs(
          'https://mint.test',
          { unit: 'usd' },
        );
        const allUsd = await repositories.proofRepository.getAllReadyProofs({ units: ['usd'] });

        expect(satProofs).toHaveLength(1);
        expect(usdProofs).toHaveLength(1);
        expect(allUsd).toHaveLength(1);
        expect(usdProofs[0]?.unit).toBe('usd');
      } finally {
        await dispose();
      }
    });

    it('rejects proofs without a unit', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        const proof = createDummyProof({ secret: 'missing-unit' }) as unknown as Omit<
          CoreProof,
          'unit'
        >;
        delete (proof as { unit?: string }).unit;

        await expectThrows(
          () => repositories.proofRepository.saveProofs('https://mint.test', [proof as CoreProof]),
          expect,
        );
      } finally {
        await dispose();
      }
    });
  });
}

export { runIntegrationTests } from './integration.ts';
export type { IntegrationTestRunner, IntegrationTestOptions } from './integration.ts';
// Migration tests temporarily disabled - architecture being reconsidered
// export { runMigrationTests } from './migrations.ts';
// export type { MigrationTestRunner, MigrationTestOptions } from './migrations.ts';
export { createFakeInvoice } from 'fake-bolt11';
export type { FakeInvoiceOptions } from 'fake-bolt11';
