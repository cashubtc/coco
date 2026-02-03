import { initializeCoco, type Repositories } from 'coco-cashu-core';

/**
 * Test runner interface for migration tests.
 * Adapters provide their test framework's implementation (e.g., bun:test, vitest, jest).
 */
export type MigrationTestRunner = {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void, timeout?: number): void;
  beforeEach(fn: () => Promise<void> | void): void;
  afterEach(fn: () => Promise<void> | void): void;
  expect: MigrationExpectation;
};

type MigrationExpectation = {
  (value: unknown): MigrationExpectApi;
};

type MigrationExpectApi = {
  toBe(value: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toEqual(value: unknown): void;
  toHaveLength(len: number): void;
  toBeGreaterThan(value: number): void;
  toBeGreaterThanOrEqual(value: number): void;
  toContain(value: unknown): void;
};

/**
 * Options for running migration tests.
 * Each adapter provides its specific implementations.
 */
export type MigrationTestOptions<TRepositories extends Repositories = Repositories> = {
  /**
   * Create fresh repositories with ALL migrations applied.
   * Used for creating realistic test data via Core API.
   */
  createRepositories: () => Promise<{
    repositories: TRepositories;
    dispose: () => Promise<void>;
  }>;

  /**
   * Create repositories with migrations run only up to (but not including) stopBeforeId.
   * Used for testing specific migration behavior.
   *
   * For SQL-based adapters (expo-sqlite, sqlite3), stopBeforeId is the migration ID like '010_rename_completed_to_finalized'.
   * For IndexedDB, stopBeforeId is the version number as a string like '8'.
   */
  createRepositoriesAtMigration: (stopBeforeId: string) => Promise<{
    repositories: TRepositories;
    dispose: () => Promise<void>;
    /**
     * Run remaining migrations (from stopBeforeId onwards).
     * Call this after setting up pre-migration state.
     */
    runRemainingMigrations: () => Promise<void>;
    /**
     * Insert data for setting up pre-migration state.
     * For SQL adapters: execute raw SQL.
     * For IndexedDB: use Dexie table operations.
     */
    rawInsert: (table: string, data: Record<string, unknown>) => Promise<void>;
    /**
     * Query data for verification.
     */
    rawQuery: <T>(table: string, filter?: Record<string, unknown>) => Promise<T[]>;
    /**
     * Update data in a table.
     */
    rawUpdate: (
      table: string,
      filter: Record<string, unknown>,
      updates: Record<string, unknown>,
    ) => Promise<void>;
  }>;

  /**
   * The migration ID/version that renames 'completed' to 'finalized'.
   * For SQL adapters: '010_rename_completed_to_finalized'
   * For IndexedDB: '8'
   */
  completedToFinalizedMigration: string;

  /**
   * The migration ID/version that adds derivationPath to keypairs.
   * For SQL adapters: '012_keypair_derivation_path'
   * For IndexedDB: '10'
   */
  keypairDerivationPathMigration?: string;

  /**
   * Logger for debugging test failures.
   */
  logger?: {
    info(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };
};

/**
 * Run migration safety tests for a storage adapter.
 *
 * These tests verify that:
 * 1. Migrations preserve existing data
 * 2. State transformations are applied correctly
 * 3. Unrelated tables are not affected
 * 4. Edge cases (empty tables, etc.) are handled
 *
 * @example
 * ```typescript
 * import { runMigrationTests } from 'coco-cashu-adapter-tests';
 * import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
 *
 * runMigrationTests({
 *   createRepositories: async () => { ... },
 *   createRepositoriesAtMigration: async (stopBeforeId) => { ... },
 *   completedToFinalizedMigration: '010_rename_completed_to_finalized',
 * }, { describe, it, expect, beforeEach, afterEach });
 * ```
 */
export function runMigrationTests<TRepositories extends Repositories = Repositories>(
  options: MigrationTestOptions<TRepositories>,
  runner: MigrationTestRunner,
): void {
  const { describe, it, expect, beforeEach, afterEach } = runner;
  const {
    createRepositories,
    createRepositoriesAtMigration,
    completedToFinalizedMigration,
    keypairDerivationPathMigration,
    logger,
  } = options;

  // Helper to create a deterministic seed for reproducible tests
  const createSeedGetter = () => {
    const seed = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      seed[i] = i;
    }
    return async () => seed;
  };

  describe('Migration Safety Tests', () => {
    describe('Data Preservation', () => {
      it('should preserve all data through full migration cycle', async () => {
        const { repositories, dispose } = await createRepositories();

        try {
          const seedGetter = createSeedGetter();

          const mgr = await initializeCoco({
            repo: repositories,
            seedGetter,
          });

          const testMintUrl = 'https://migration-test.mint';

          // Add a mint
          await repositories.mintRepository.addOrUpdateMint({
            mintUrl: testMintUrl,
            name: 'Migration Test Mint',
            mintInfo: {
              name: 'Migration Test Mint',
              pubkey: 'test-pubkey',
              version: '1.0.0',
              contact: {},
              nuts: {},
            } as any,
            trusted: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });

          // Add keyset
          await repositories.keysetRepository.addKeyset({
            mintUrl: testMintUrl,
            id: 'test-keyset-001',
            unit: 'sat',
            keypairs: { '1': { pubKey: 'pk1' }, '2': { pubKey: 'pk2' } } as any,
            active: true,
            feePpk: 0,
          });

          // Add proofs (user's money!)
          await repositories.proofRepository.saveProofs(testMintUrl, [
            {
              id: 'test-keyset-001',
              amount: 100,
              secret: 'migration-test-secret-1',
              C: 'C1',
              mintUrl: testMintUrl,
              state: 'ready',
            },
            {
              id: 'test-keyset-001',
              amount: 50,
              secret: 'migration-test-secret-2',
              C: 'C2',
              mintUrl: testMintUrl,
              state: 'ready',
            },
          ]);

          // Add counter
          await repositories.counterRepository.setCounter(testMintUrl, 'test-keyset-001', 10);

          // Record state before
          const mintsBefore = await repositories.mintRepository.getAllMints();
          const keysetsBefore =
            await repositories.keysetRepository.getKeysetsByMintUrl(testMintUrl);
          const proofsBefore = await repositories.proofRepository.getAllReadyProofs();
          const counterBefore = await repositories.counterRepository.getCounter(
            testMintUrl,
            'test-keyset-001',
          );

          await mgr.dispose();

          // Re-initialize (simulates app restart after update)
          const mgr2 = await initializeCoco({
            repo: repositories,
            seedGetter,
          });

          // Verify ALL data survived
          const mintsAfter = await repositories.mintRepository.getAllMints();
          const keysetsAfter = await repositories.keysetRepository.getKeysetsByMintUrl(testMintUrl);
          const proofsAfter = await repositories.proofRepository.getAllReadyProofs();
          const counterAfter = await repositories.counterRepository.getCounter(
            testMintUrl,
            'test-keyset-001',
          );

          // Mints preserved
          expect(mintsAfter.length).toBe(mintsBefore.length);
          const testMint = mintsAfter.find((m) => m.mintUrl === testMintUrl);
          expect(testMint).toBeDefined();
          expect(testMint!.name).toBe('Migration Test Mint');

          // Keysets preserved
          expect(keysetsAfter.length).toBe(keysetsBefore.length);

          // Proofs preserved (CRITICAL!)
          expect(proofsAfter.length).toBe(proofsBefore.length);
          const totalBefore = proofsBefore.reduce((sum, p) => sum + p.amount, 0);
          const totalAfter = proofsAfter.reduce((sum, p) => sum + p.amount, 0);
          expect(totalAfter).toBe(totalBefore);

          // Counter preserved
          expect(counterAfter?.counter).toBe(counterBefore?.counter);

          await mgr2.dispose();

          logger?.info('Data preservation test passed', {
            mints: mintsAfter.length,
            keysets: keysetsAfter.length,
            proofs: proofsAfter.length,
            totalBalance: totalAfter,
          });
        } finally {
          await dispose();
        }
      });
    });

    describe('completed -> finalized migration', () => {
      it('should transform completed state to finalized', async () => {
        const { repositories, dispose, runRemainingMigrations, rawInsert, rawQuery } =
          await createRepositoriesAtMigration(completedToFinalizedMigration);

        try {
          // Insert send operation with OLD 'completed' state (pre-migration)
          await rawInsert('coco_cashu_send_operations', {
            id: 'op-completed-1',
            mintUrl: 'https://mint.test',
            amount: 100,
            state: 'completed',
            createdAt: 1000,
            updatedAt: 1000,
          });

          // Insert another with 'pending' state (should not change)
          await rawInsert('coco_cashu_send_operations', {
            id: 'op-pending-1',
            mintUrl: 'https://mint.test',
            amount: 200,
            state: 'pending',
            createdAt: 1001,
            updatedAt: 1001,
          });

          // Insert history entry with 'completed' state
          await rawInsert('coco_cashu_history', {
            mintUrl: 'https://mint.test',
            type: 'send',
            unit: 'sat',
            amount: 100,
            createdAt: 1000,
            state: 'completed',
            operationId: 'op-completed-1',
          });

          // Run the migration
          await runRemainingMigrations();

          // Verify send_operations state transformed
          const ops = await rawQuery<{ id: string; state: string; amount: number }>(
            'coco_cashu_send_operations',
          );

          expect(ops).toHaveLength(2);

          const completedOp = ops.find((o) => o.id === 'op-completed-1');
          expect(completedOp).toBeDefined();
          expect(completedOp!.state).toBe('finalized');
          expect(completedOp!.amount).toBe(100);

          const pendingOp = ops.find((o) => o.id === 'op-pending-1');
          expect(pendingOp).toBeDefined();
          expect(pendingOp!.state).toBe('pending');

          // Verify history state transformed
          const history = await rawQuery<{ state: string; type: string }>('coco_cashu_history', {
            type: 'send',
          });

          expect(history).toHaveLength(1);
          expect(history[0]!.state).toBe('finalized');

          logger?.info('State transformation test passed');
        } finally {
          await dispose();
        }
      });

      it('should preserve all send_operations data during migration', async () => {
        const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
          await createRepositoriesAtMigration(completedToFinalizedMigration);

        try {
          // Insert comprehensive send operation with all fields
          await rawInsert('coco_cashu_send_operations', {
            id: 'op-full-data',
            mintUrl: 'https://mint.test',
            amount: 100,
            state: 'completed',
            createdAt: 1000,
            updatedAt: 2000,
            error: 'some error',
            needsSwap: 1,
            fee: 5,
            inputAmount: 105,
            inputProofSecretsJson: '["secret1","secret2"]',
            outputDataJson: '{"key":"value"}',
          });

          await runRemainingMigrations();

          const ops = await rawQuery<{
            id: string;
            mintUrl: string;
            amount: number;
            state: string;
            createdAt: number;
            updatedAt: number;
            error: string | null;
            needsSwap: number | null;
            fee: number | null;
            inputAmount: number | null;
            inputProofSecretsJson: string | null;
            outputDataJson: string | null;
          }>('coco_cashu_send_operations', { id: 'op-full-data' });

          expect(ops).toHaveLength(1);
          const op = ops[0]!;

          expect(op.id).toBe('op-full-data');
          expect(op.mintUrl).toBe('https://mint.test');
          expect(op.amount).toBe(100);
          expect(op.state).toBe('finalized');
          expect(op.createdAt).toBe(1000);
          expect(op.updatedAt).toBe(2000);
          expect(op.error).toBe('some error');
          expect(op.fee).toBe(5);
          expect(op.inputAmount).toBe(105);

          logger?.info('Data preservation test passed');
        } finally {
          await dispose();
        }
      });

      it('should NOT affect proofs table', async () => {
        const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
          await createRepositoriesAtMigration(completedToFinalizedMigration);

        try {
          // Insert proofs (user's balance!)
          await rawInsert('coco_cashu_proofs', {
            mintUrl: 'https://mint.test',
            id: 'keyset-1',
            amount: 100,
            secret: 'proof-secret-1',
            C: 'C1',
            state: 'ready',
            createdAt: 1000,
          });

          await rawInsert('coco_cashu_proofs', {
            mintUrl: 'https://mint.test',
            id: 'keyset-1',
            amount: 50,
            secret: 'proof-secret-2',
            C: 'C2',
            state: 'ready',
            createdAt: 1001,
          });

          const proofsBefore = await rawQuery<{ secret: string; amount: number; state: string }>(
            'coco_cashu_proofs',
          );

          await runRemainingMigrations();

          const proofsAfter = await rawQuery<{ secret: string; amount: number; state: string }>(
            'coco_cashu_proofs',
          );

          expect(proofsAfter).toHaveLength(proofsBefore.length);

          const totalBefore = proofsBefore.reduce((sum, p) => sum + p.amount, 0);
          const totalAfter = proofsAfter.reduce((sum, p) => sum + p.amount, 0);
          expect(totalAfter).toBe(totalBefore);
          expect(totalAfter).toBe(150);

          logger?.info('Proofs preservation test passed', {
            proofCount: proofsAfter.length,
            totalBalance: totalAfter,
          });
        } finally {
          await dispose();
        }
      });

      it('should NOT affect mints table', async () => {
        const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
          await createRepositoriesAtMigration(completedToFinalizedMigration);

        try {
          await rawInsert('coco_cashu_mints', {
            mintUrl: 'https://mint.test',
            name: 'Test Mint',
            mintInfo: '{}',
            createdAt: 1000,
            updatedAt: 2000,
            trusted: 1,
          });

          const mintsBefore = await rawQuery<{ mintUrl: string; name: string }>('coco_cashu_mints');

          await runRemainingMigrations();

          const mintsAfter = await rawQuery<{ mintUrl: string; name: string }>('coco_cashu_mints');

          expect(mintsAfter.length).toBe(mintsBefore.length);
          expect(mintsAfter[0]!.mintUrl).toBe(mintsBefore[0]!.mintUrl);
          expect(mintsAfter[0]!.name).toBe(mintsBefore[0]!.name);

          logger?.info('Mints preservation test passed');
        } finally {
          await dispose();
        }
      });

      it('should NOT affect counters table', async () => {
        const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
          await createRepositoriesAtMigration(completedToFinalizedMigration);

        try {
          await rawInsert('coco_cashu_counters', {
            mintUrl: 'https://mint.test',
            keysetId: 'keyset-1',
            counter: 42,
          });

          const countersBefore = await rawQuery<{ mintUrl: string; counter: number }>(
            'coco_cashu_counters',
          );

          await runRemainingMigrations();

          const countersAfter = await rawQuery<{ mintUrl: string; counter: number }>(
            'coco_cashu_counters',
          );

          expect(countersAfter.length).toBe(countersBefore.length);
          expect(countersAfter[0]!.counter).toBe(42);

          logger?.info('Counters preservation test passed');
        } finally {
          await dispose();
        }
      });

      it('should handle empty send_operations table gracefully', async () => {
        const { dispose, runRemainingMigrations, rawQuery } = await createRepositoriesAtMigration(
          completedToFinalizedMigration,
        );

        try {
          // Don't insert any data - simulate fresh install
          await runRemainingMigrations();

          const ops = await rawQuery('coco_cashu_send_operations');
          expect(ops).toHaveLength(0);

          logger?.info('Empty table test passed');
        } finally {
          await dispose();
        }
      });

      it('should handle all valid states correctly', async () => {
        const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
          await createRepositoriesAtMigration(completedToFinalizedMigration);

        try {
          const preMigrationStates = [
            'init',
            'prepared',
            'executing',
            'pending',
            'completed',
            'rolling_back',
            'rolled_back',
          ];

          for (let i = 0; i < preMigrationStates.length; i++) {
            await rawInsert('coco_cashu_send_operations', {
              id: `op-state-${i}`,
              mintUrl: 'https://mint.test',
              amount: 100 + i,
              state: preMigrationStates[i],
              createdAt: 1000 + i,
              updatedAt: 1000 + i,
            });
          }

          await runRemainingMigrations();

          const ops = await rawQuery<{ id: string; state: string }>('coco_cashu_send_operations');

          expect(ops).toHaveLength(7);

          const stateMap = new Map(ops.map((o) => [o.id, o.state]));

          expect(stateMap.get('op-state-0')).toBe('init');
          expect(stateMap.get('op-state-1')).toBe('prepared');
          expect(stateMap.get('op-state-2')).toBe('executing');
          expect(stateMap.get('op-state-3')).toBe('pending');
          expect(stateMap.get('op-state-4')).toBe('finalized'); // TRANSFORMED!
          expect(stateMap.get('op-state-5')).toBe('rolling_back');
          expect(stateMap.get('op-state-6')).toBe('rolled_back');

          logger?.info('All states test passed');
        } finally {
          await dispose();
        }
      });
    });

    if (keypairDerivationPathMigration) {
      describe('keypair derivationPath migration', () => {
        it('should backfill derivationPath from derivationIndex', async () => {
          const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
            await createRepositoriesAtMigration(keypairDerivationPathMigration);

          try {
            await rawInsert('coco_cashu_keypairs', {
              publicKey: 'pk-derivation-0',
              secretKey: '00',
              createdAt: 1000,
              derivationIndex: 0,
            });

            await rawInsert('coco_cashu_keypairs', {
              publicKey: 'pk-derivation-7',
              secretKey: '01',
              createdAt: 1001,
              derivationIndex: 7,
            });

            await runRemainingMigrations();

            const keypairs = await rawQuery<{
              publicKey: string;
              derivationIndex: number | null;
              derivationPath: string | null;
            }>('coco_cashu_keypairs');

            const keypair0 = keypairs.find((kp) => kp.publicKey === 'pk-derivation-0');
            const keypair7 = keypairs.find((kp) => kp.publicKey === 'pk-derivation-7');

            expect(keypair0?.derivationPath).toBe("m/129373'/10'/0'/0'/0");
            expect(keypair7?.derivationPath).toBe("m/129373'/10'/0'/0'/7");
          } finally {
            await dispose();
          }
        });

        it('should not override existing derivationPath', async () => {
          const { dispose, runRemainingMigrations, rawInsert, rawQuery } =
            await createRepositoriesAtMigration(keypairDerivationPathMigration);

          try {
            await rawInsert('coco_cashu_keypairs', {
              publicKey: 'pk-derivation-existing',
              secretKey: '02',
              createdAt: 1002,
              derivationIndex: 3,
              derivationPath: "m/129373'/10'/0'/0'/999",
            });

            await runRemainingMigrations();

            const keypairs = await rawQuery<{
              publicKey: string;
              derivationPath: string | null;
            }>('coco_cashu_keypairs', { publicKey: 'pk-derivation-existing' });

            expect(keypairs).toHaveLength(1);
            const keypair = keypairs[0];
            expect(keypair).toBeDefined();
            expect(keypair?.derivationPath).toBe("m/129373'/10'/0'/0'/999");
          } finally {
            await dispose();
          }
        });
      });
    }
  });
}
