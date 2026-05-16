import {
  Amount,
  type Mint,
  type Keyset,
  type CoreProof,
  type Repositories,
  type MeltOperation,
  type MintOperation,
  type ReceiveOperation,
  type SendOperation,
  type AuthSession,
} from '@cashu/coco-core';

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
        const operation = createDummyMeltOperation({ unit: 'usd' });
        await repositories.meltOperationRepository.create(operation);

        const stored = await repositories.meltOperationRepository.getById(operation.id);

        expect(stored).toBeDefined();
        expect(stored!.state).toBe('init');
        expect(stored!.unit).toBe('usd');
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
