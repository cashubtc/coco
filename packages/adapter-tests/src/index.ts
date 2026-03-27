import type {
  Mint,
  Keyset,
  CoreProof,
  Repositories,
  MeltOperation,
  AuthSession,
} from 'coco-cashu-core';

type TransactionFactory<TRepositories extends Repositories = Repositories> = () => Promise<{
  repositories: TRepositories;
  dispose(): Promise<void>;
}>;

type ContractOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: TransactionFactory<TRepositories>;
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
    amount: 1,
    secret: 'secret',
    C: 'C',
    mintUrl: 'https://mint.test',
    state: 'ready',
    ...overrides,
  } satisfies CoreProof;
}

export function createDummyMeltOperation(): MeltOperation {
  return {
    id: 'melt-op',
    state: 'init',
    mintUrl: 'https://mint.test',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test' },
    createdAt: 0,
    updatedAt: 0,
  } satisfies MeltOperation;
}

export function createDummyAuthSession(overrides?: Partial<AuthSession>): AuthSession {
  return {
    mintUrl: 'https://mint.test',
    accessToken: 'access-token-123',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
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
            { id: 'proof-1', amount: 1, secret: 's1', C: 'C1' },
            { id: 'proof-2', amount: 2, secret: 's2', C: 'C2' },
          ] as AuthSession['batPool'],
        });
        await repo.saveSession(session);

        const result = await repo.getSession(session.mintUrl);
        expect(result).toBeDefined();
        expect(result!.refreshToken).toBe('refresh-xyz');
        expect(result!.scope).toBe('read write');
        expect(result!.batPool).toBeDefined();
        expect(result!.batPool!).toHaveLength(2);
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
  });
}

export { runIntegrationTests } from './integration.ts';
export type { IntegrationTestRunner, IntegrationTestOptions } from './integration.ts';
// Migration tests temporarily disabled - architecture being reconsidered
// export { runMigrationTests } from './migrations.ts';
// export type { MigrationTestRunner, MigrationTestOptions } from './migrations.ts';
export { createFakeInvoice } from 'fake-bolt11';
export type { FakeInvoiceOptions } from 'fake-bolt11';
