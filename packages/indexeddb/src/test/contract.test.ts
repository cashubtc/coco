import { describe, it, expect } from 'vitest';
import { Amount } from '@cashu/cashu-ts';
import Dexie from 'dexie';
import {
  runRepositoryTransactionContract,
  runKeyRingDerivationRepositoryContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runMintQuoteRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
  runDurableEventOutboxRepositoryContract,
  runDurableEventOutboxHostContract,
  createDurableEventOutboxRepositoryFromTransactionPort,
} from '@cashu/coco-adapter-tests';
import type {
  DurableEventRevisionBatch,
  DurableEventStorageLimits,
} from '@cashu/coco-core/adapter';
import {
  ensureSchema,
  IdbDb,
  IdbDurableEventOutboxRepository,
  IDB_DURABLE_EVENT_OUTBOX_STORES,
  IndexedDbRepositories,
} from '../index.ts';
import { createTransactionalIdbDurableEventOutboxRepository } from './durableEventOutbox.ts';

let dbCounter = 0;

function outboxBatch(): DurableEventRevisionBatch {
  return {
    streamId: 'operation-1',
    expectedPreviousRevision: 0,
    streamRevision: 1,
    events: [
      {
        id: 'operation-1-event-1',
        eventKey: 'project-history',
        consumerId: 'wallet.history.projector',
        eventType: 'wallet.operation.finalized',
        envelopeVersion: 1,
        payloadVersion: 1,
        streamId: 'operation-1',
        streamRevision: 1,
        payload: { operationId: 'operation-1' },
        occurredAt: 100,
      },
    ],
  };
}

function runOutboxClaimWorker(
  dbName: string,
  token: string,
  workerId: string,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./durableEventOutbox.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<{ result: string | null; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
    worker.postMessage({ dbName, action: 'claim', token, workerId });
  });
}

function runOutboxEnqueueWorker(dbName: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./durableEventOutbox.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<{ result: string | null; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
    worker.postMessage({ dbName, action: 'enqueue' });
  });
}

function deriveKeyPair(derivationIndex: number, purpose: 'p2pk' | 'nut20_mint_quote') {
  return {
    publicKeyHex:
      (purpose === 'p2pk' ? '02' : '03') + derivationIndex.toString(16).padStart(64, '0'),
    secretKey: new Uint8Array(32).fill((derivationIndex % 254) + 1),
    derivationIndex,
    purpose,
  };
}

async function createRepositories() {
  const dbName = `coco_cashu_contract_${Date.now()}_${dbCounter++}`;
  const repositories = new IndexedDbRepositories({ name: dbName });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      repositories.db.close();
    },
  };
}

async function createSharedRepositories() {
  const dbName = `coco_cashu_shared_allocation_${Date.now()}_${dbCounter++}`;
  const first = new IndexedDbRepositories({ name: dbName });
  const second = new IndexedDbRepositories({ name: dbName });
  await first.init();
  await second.init();

  return {
    first,
    second,
    dispose: async () => {
      first.db.close();
      second.db.close();
    },
  };
}

async function expectRejects(fn: () => Promise<void>) {
  let didThrow = false;
  try {
    await fn();
  } catch {
    didThrow = true;
  }
  expect(didThrow).toBe(true);
}

runRepositoryTransactionContract(
  {
    createRepositories,
  },
  { describe, it, expect },
);

runKeyRingDerivationRepositoryContract(
  { createRepositories, createSharedRepositories },
  { describe, it, expect },
);

runDurableEventOutboxRepositoryContract(
  {
    async createRepository(options?: { readonly limits?: DurableEventStorageLimits }) {
      const dbName = `coco_cashu_outbox_contract_${Date.now()}_${dbCounter++}`;
      const repositories = new IndexedDbRepositories({ name: dbName });
      await repositories.init();
      if (options?.limits) {
        await repositories.configureDurableEventOutboxStorageLimits(options.limits);
      }
      return {
        repository: createDurableEventOutboxRepositoryFromTransactionPort(
          repositories.durableEventOutbox,
        ),
        dispose: async () => {
          repositories.db.close();
          await Dexie.delete(dbName);
        },
      };
    },
    async createSharedRepositories() {
      const dbName = `coco_cashu_outbox_shared_${Date.now()}_${dbCounter++}`;
      const firstRepositories = new IndexedDbRepositories({ name: dbName });
      const secondRepositories = new IndexedDbRepositories({ name: dbName });
      await firstRepositories.init();
      await secondRepositories.init();
      return {
        first: createDurableEventOutboxRepositoryFromTransactionPort(
          firstRepositories.durableEventOutbox,
        ),
        second: createDurableEventOutboxRepositoryFromTransactionPort(
          secondRepositories.durableEventOutbox,
        ),
        dispose: async () => {
          firstRepositories.db.close();
          secondRepositories.db.close();
          await Dexie.delete(dbName);
        },
      };
    },
    async createRestartableRepository() {
      const dbName = `coco_cashu_outbox_restart_${Date.now()}_${dbCounter++}`;
      let repositories = new IndexedDbRepositories({ name: dbName });
      await repositories.init();
      const reopen = async () => {
        repositories.db.close();
        repositories = new IndexedDbRepositories({ name: dbName });
        await repositories.init();
        return createDurableEventOutboxRepositoryFromTransactionPort(
          repositories.durableEventOutbox,
        );
      };
      return {
        repository: createDurableEventOutboxRepositoryFromTransactionPort(
          repositories.durableEventOutbox,
        ),
        restart: reopen,
        dispose: async () => {
          repositories.db.close();
          await Dexie.delete(dbName);
        },
      };
    },
  },
  { describe, it, expect },
);

runDurableEventOutboxHostContract({ createRepositories }, { describe, it, expect });

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMintQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

describe('indexeddb durable event outbox transaction boundaries', () => {
  it('rolls producer state and its event batch back in one IndexedDB transaction', async () => {
    const dbName = `coco_cashu_outbox_producer_rollback_${Date.now()}_${dbCounter++}`;
    const database = new IdbDb({ name: dbName });
    await ensureSchema(database);
    try {
      await expectRejects(async () => {
        await database.runTransaction(
          'rw',
          ['coco_cashu_mints', ...IDB_DURABLE_EVENT_OUTBOX_STORES],
          async (transaction) => {
            await transaction.table('coco_cashu_mints').add({
              mintUrl: 'https://mint.test',
              name: 'Rolled back mint',
              trusted: true,
              updatedAt: 100,
            });
            await new IdbDurableEventOutboxRepository(transaction).enqueueRevision(
              outboxBatch(),
              100,
            );
            throw new Error('abort producer transaction');
          },
        );
      });

      expect(await database.table('coco_cashu_mints').get('https://mint.test')).toBeUndefined();
      expect(
        (await createTransactionalIdbDurableEventOutboxRepository(database).getStorageStats())
          .eventRows,
      ).toBe(0);
    } finally {
      database.close();
      await Dexie.delete(dbName);
    }
  });

  it('rolls a local effect and publication back in one IndexedDB transaction', async () => {
    const dbName = `coco_cashu_outbox_consumer_rollback_${Date.now()}_${dbCounter++}`;
    const database = new IdbDb({ name: dbName });
    await ensureSchema(database);
    try {
      const repository = createTransactionalIdbDurableEventOutboxRepository(database);
      await repository.enqueueRevision(outboxBatch(), 100);
      const claim = await repository.claimNext({
        workerId: 'worker-1',
        leaseToken: 'lease-1',
        leaseDurationMs: 1_000,
        now: 100,
        contracts: [outboxBatch().events[0]!],
      });
      if (!claim) throw new Error('expected a claim');

      await expectRejects(async () => {
        await database.runTransaction(
          'rw',
          ['coco_cashu_mints', ...IDB_DURABLE_EVENT_OUTBOX_STORES],
          async (transaction) => {
            const scoped = new IdbDurableEventOutboxRepository(transaction);
            expect(await scoped.readAndValidateCurrentClaim(claim)).not.toBeNull();
            await transaction.table('coco_cashu_mints').add({
              mintUrl: 'https://effect.test',
              name: 'Rolled back effect',
              trusted: true,
              updatedAt: 110,
            });
            expect(await scoped.markPublished(claim.id, claim.leaseToken, 110)).toBe('updated');
            throw new Error('abort consumer transaction');
          },
        );
      });

      expect(await database.table('coco_cashu_mints').get('https://effect.test')).toBeUndefined();
      expect(await repository.readAndValidateCurrentClaim(claim)).not.toBeNull();
    } finally {
      database.close();
      await Dexie.delete(dbName);
    }
  });

  it('migrates version 33 data without changing existing wallet rows', async () => {
    const dbName = `coco_cashu_outbox_migration_${Date.now()}_${dbCounter++}`;
    const legacy = new Dexie(dbName);
    legacy.version(33).stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    });
    await legacy.open();
    await legacy.table('coco_cashu_mints').add({
      mintUrl: 'https://mint.test',
      name: 'Preserved mint',
      trusted: true,
      updatedAt: 123,
    });
    let receivedVersionChange = false;
    legacy.on('versionchange', () => {
      receivedVersionChange = true;
      legacy.close();
    });

    const database = new IdbDb({ name: dbName });
    await ensureSchema(database);
    try {
      expect(receivedVersionChange).toBe(true);
      expect(legacy.isOpen()).toBe(false);
      expect(await database.table('coco_cashu_mints').get('https://mint.test')).toEqual({
        mintUrl: 'https://mint.test',
        name: 'Preserved mint',
        trusted: true,
        updatedAt: 123,
      });
      expect(
        (await createTransactionalIdbDurableEventOutboxRepository(database).getStorageStats())
          .eventRows,
      ).toBe(0);
      await legacy.table('coco_cashu_mints').add({
        mintUrl: 'https://stale-session.test',
        name: 'Stale session write',
        trusted: true,
        updatedAt: 124,
      });
      expect(await database.table('coco_cashu_mints').get('https://stale-session.test')).toEqual({
        mintUrl: 'https://stale-session.test',
        name: 'Stale session write',
        trusted: true,
        updatedAt: 124,
      });
    } finally {
      legacy.close();
      database.close();
      await Dexie.delete(dbName);
    }
  });

  it('fails when the caller omits a required outbox store from the transaction', async () => {
    const dbName = `coco_cashu_outbox_store_union_${Date.now()}_${dbCounter++}`;
    const database = new IdbDb({ name: dbName });
    await ensureSchema(database);
    try {
      await expectRejects(async () => {
        await database.runTransaction('rw', [IDB_DURABLE_EVENT_OUTBOX_STORES[0]], (transaction) =>
          new IdbDurableEventOutboxRepository(transaction).enqueueRevision(outboxBatch(), 100),
        );
      });
      expect(
        (await createTransactionalIdbDurableEventOutboxRepository(database).getStorageStats())
          .eventRows,
      ).toBe(0);
    } finally {
      database.close();
      await Dexie.delete(dbName);
    }
  });

  it('blocks a corrupt payload during claim so later work can continue', async () => {
    const dbName = `coco_cashu_outbox_corrupt_claim_${Date.now()}_${dbCounter++}`;
    const repositories = new IndexedDbRepositories({ name: dbName });
    await repositories.init();
    try {
      await repositories.durableEventOutbox.run((outbox) =>
        outbox.enqueueRevision(outboxBatch(), 100),
      );
      await repositories.durableEventOutbox.run((outbox) =>
        outbox.enqueueRevision(
          {
            streamId: 'operation-2',
            expectedPreviousRevision: 0,
            streamRevision: 1,
            events: [
              {
                ...outboxBatch().events[0]!,
                id: 'operation-2-event-1',
                streamId: 'operation-2',
                payload: { operationId: 'operation-2' },
                occurredAt: 101,
              },
            ],
          },
          100,
        ),
      );
      await repositories.db
        .table(IDB_DURABLE_EVENT_OUTBOX_STORES[0])
        .update('operation-1-event-1', { payloadJson: '{not-json' });

      await expect(
        repositories.durableEventOutbox.run((outbox) =>
          outbox.claimNext({
            workerId: 'worker-1',
            leaseToken: 'corrupt-token',
            leaseDurationMs: 1_000,
            now: 100,
            contracts: [outboxBatch().events[0]!],
          }),
        ),
      ).resolves.toMatchObject({ id: 'operation-2-event-1' });

      expect(
        await repositories.db.table(IDB_DURABLE_EVENT_OUTBOX_STORES[0]).get('operation-1-event-1'),
      ).toMatchObject({
        status: 'blocked',
        lastErrorCode: 'outbox.corrupt_record',
        failureCount: 1,
        totalFailureCount: 1,
      });
    } finally {
      repositories.db.close();
      await Dexie.delete(dbName);
    }
  });

  it('allows only one browser Worker to claim one stored event', async () => {
    const dbName = `coco_cashu_outbox_worker_${Date.now()}_${dbCounter++}`;
    const database = new IdbDb({ name: dbName });
    await ensureSchema(database);
    try {
      await createTransactionalIdbDurableEventOutboxRepository(database).enqueueRevision(
        outboxBatch(),
        100,
      );
      const claims = await Promise.all([
        runOutboxClaimWorker(dbName, 'worker-token-1', 'browser-worker-1'),
        runOutboxClaimWorker(dbName, 'worker-token-2', 'browser-worker-2'),
      ]);
      expect(claims.filter((id) => id !== null)).toHaveLength(1);
      expect(claims.find((id) => id !== null)).toBe('operation-1-event-1');
    } finally {
      database.close();
      await Dexie.delete(dbName);
    }
  });

  it('serializes an identical enqueue race across browser Workers', async () => {
    const dbName = `coco_cashu_outbox_worker_enqueue_${Date.now()}_${dbCounter++}`;
    const database = new IdbDb({ name: dbName });
    await ensureSchema(database);
    try {
      expect(
        (
          await Promise.all([runOutboxEnqueueWorker(dbName), runOutboxEnqueueWorker(dbName)])
        ).sort(),
      ).toEqual(['existing', 'inserted']);
      const stats =
        await createTransactionalIdbDurableEventOutboxRepository(database).getStorageStats();
      expect(stats.eventRows).toBe(1);
      expect(stats.revisionSeals).toBe(1);
    } finally {
      database.close();
      await Dexie.delete(dbName);
    }
  });
});

describe('indexeddb quote storage constraints', () => {
  it('rolls back the keypair and high-water mark when persistence aborts', async () => {
    const { repositories, dispose } = await createRepositories();
    const allocationTable = repositories.db.table('coco_cashu_keypair_derivation_allocations');
    const failAllocationWrite = () => {
      throw new Error('forced high-water failure');
    };
    allocationTable.hook('creating').subscribe(failAllocationWrite);
    try {
      await expectRejects(async () => {
        await repositories.keyRingRepository.deriveAndPersistKeyPair('p2pk', (index) =>
          deriveKeyPair(index, 'p2pk'),
        );
      });

      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
      expect(await allocationTable.get('p2pk')).toBeUndefined();
      allocationTable.hook('creating').unsubscribe(failAllocationWrite);
      await expect(
        repositories.keyRingRepository.deriveAndPersistKeyPair('p2pk', (index) =>
          deriveKeyPair(index, 'p2pk'),
        ),
      ).resolves.toMatchObject({ derivationIndex: 0 });
    } finally {
      allocationTable.hook('creating').unsubscribe(failAllocationWrite);
      await dispose();
    }
  });

  it('migrates version-32 keypairs into purpose-scoped allocation state', async () => {
    const dbName = `coco_cashu_keyring_migration_${Date.now()}_${dbCounter++}`;
    const legacy = new Dexie(dbName);
    legacy.version(32).stores({
      coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
    });
    await legacy.open();
    await legacy.table('coco_cashu_keypairs').bulkAdd([
      {
        publicKey: 'legacy-p2pk',
        secretKey: '01'.repeat(32),
        createdAt: 1,
        derivationIndex: 4,
      },
      {
        publicKey: 'current-p2pk',
        secretKey: '02'.repeat(32),
        createdAt: 2,
        derivationIndex: 6,
        purpose: 'p2pk',
      },
      {
        publicKey: 'quote-lock',
        secretKey: '03'.repeat(32),
        createdAt: 3,
        derivationIndex: 3,
        purpose: 'nut20_mint_quote',
      },
      {
        publicKey: 'imported',
        secretKey: '04'.repeat(32),
        createdAt: 4,
      },
    ]);
    legacy.close();

    const repositories = new IndexedDbRepositories({ name: dbName });
    await repositories.init();
    try {
      const keypairRows = await repositories.db.table('coco_cashu_keypairs').toArray();
      expect(keypairRows.find((row) => row.publicKey === 'legacy-p2pk')?.purpose).toBe('p2pk');
      expect(keypairRows.find((row) => row.publicKey === 'imported')?.purpose).toBe('p2pk');
      expect(
        await repositories.db.table('coco_cashu_keypair_derivation_allocations').toArray(),
      ).toEqual(
        expect.arrayContaining([
          { purpose: 'p2pk', lastAllocatedIndex: 6 },
          { purpose: 'nut20_mint_quote', lastAllocatedIndex: 3 },
        ]),
      );
      expect(
        repositories.db
          .table('coco_cashu_keypairs')
          .schema.indexes.some((index) => index.name === '[purpose+derivationIndex]'),
      ).toBe(true);
      await expect(
        repositories.keyRingRepository.deriveAndPersistKeyPair('p2pk', (index) =>
          deriveKeyPair(index, 'p2pk'),
        ),
      ).resolves.toMatchObject({ derivationIndex: 7 });
      await expect(
        repositories.keyRingRepository.deriveAndPersistKeyPair('nut20_mint_quote', (index) =>
          deriveKeyPair(index, 'nut20_mint_quote'),
        ),
      ).resolves.toMatchObject({ derivationIndex: 4 });
    } finally {
      repositories.db.close();
    }

    const reopened = new IndexedDbRepositories({ name: dbName });
    await reopened.init();
    try {
      await expect(
        reopened.keyRingRepository.deriveAndPersistKeyPair('p2pk', (index) =>
          deriveKeyPair(index, 'p2pk'),
        ),
      ).resolves.toMatchObject({ derivationIndex: 8 });
    } finally {
      reopened.db.close();
      await Dexie.delete(dbName);
    }
  });

  it('migrates canonical Mint Quote Accounting without inventing remote time', async () => {
    const dbName = `coco_cashu_migration_${Date.now()}_${dbCounter++}`;
    const legacy = new Dexie(dbName);
    legacy.version(31).stores({
      coco_cashu_canonical_mint_quotes:
        '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
    });
    await legacy.open();
    await legacy.table('coco_cashu_canonical_mint_quotes').bulkAdd([
      {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'legacy-paid',
        state: 'PAID',
        request: 'lnbc1paid',
        amount: '10',
        unit: 'sat',
        expiry: null,
        pubkey: null,
        quoteDataJson: '{"amount":"10"}',
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 123_000,
        reusable: 0,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        mintUrl: 'https://mint.test',
        method: 'onchain',
        quoteId: 'legacy-reusable',
        state: null,
        request: 'bc1qdeposit',
        amount: null,
        unit: 'sat',
        expiry: null,
        pubkey: '02',
        quoteDataJson: '{"pubkey":"02","amountPaid":"21","amountIssued":"8"}',
        lastObservedRemoteState: null,
        lastObservedRemoteStateAt: 123_000,
        reusable: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        mintUrl: 'https://mint.test',
        method: 'onchain',
        quoteId: 'legacy-malformed',
        state: null,
        request: 'bc1qmalformed',
        amount: null,
        unit: 'sat',
        expiry: null,
        pubkey: '02',
        quoteDataJson: '{not-json',
        lastObservedRemoteState: null,
        lastObservedRemoteStateAt: 123_000,
        reusable: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'legacy-bolt11-malformed',
        state: 'PAID',
        request: 'lnbc1malformed',
        amount: '13',
        unit: 'sat',
        expiry: null,
        pubkey: null,
        quoteDataJson: '{not-json',
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 123_000,
        reusable: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    legacy.close();

    const repositories = new IndexedDbRepositories({ name: dbName });
    await repositories.init();
    try {
      const paid = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'bolt11',
        'legacy-paid',
      );
      const reusable = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'onchain',
        'legacy-reusable',
      );
      const malformed = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'onchain',
        'legacy-malformed',
      );
      const malformedBolt11 = await repositories.mintQuoteRepository.getMintQuote(
        'https://mint.test',
        'bolt11',
        'legacy-bolt11-malformed',
      );

      expect(paid?.amountPaid.toString()).toBe('10');
      expect(paid?.amountIssued.toString()).toBe('0');
      expect(paid?.remoteUpdatedAt).toBe(null);
      expect(reusable?.amountPaid.toString()).toBe('21');
      expect(reusable?.amountIssued.toString()).toBe('8');
      expect(reusable?.remoteUpdatedAt).toBe(null);
      expect(malformed?.amountPaid.toString()).toBe('0');
      expect(malformed?.amountIssued.toString()).toBe('0');
      expect(malformed?.remoteUpdatedAt).toBe(null);
      expect(malformedBolt11?.amountPaid.toString()).toBe('13');
      expect(malformedBolt11?.amountIssued.toString()).toBe('0');
      expect(malformedBolt11?.remoteUpdatedAt).toBe(null);
    } finally {
      repositories.db.close();
      await Dexie.delete(dbName);
    }
  });

  it('rejects persisted mint quote method siblings for one identity', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.table('coco_cashu_canonical_mint_quotes').add({
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'duplicate-mint-quote',
        state: 'UNPAID',
        request: 'bolt11-request',
        amount: '1',
        unit: 'sat',
        expiry: null,
        pubkey: null,
        quoteDataJson: '{"amount":"1"}',
        lastObservedRemoteState: 'UNPAID',
        lastObservedRemoteStateAt: 0,
        reusable: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      await expectRejects(async () => {
        await repositories.db.table('coco_cashu_canonical_mint_quotes').add({
          mintUrl: 'https://mint.test',
          method: 'bolt12',
          quoteId: 'duplicate-mint-quote',
          state: null,
          request: 'bolt12-request',
          amount: null,
          unit: 'sat',
          expiry: null,
          pubkey: '02',
          quoteDataJson: '{"pubkey":"02","amountPaid":"0","amountIssued":"0"}',
          lastObservedRemoteState: null,
          lastObservedRemoteStateAt: 0,
          reusable: 1,
          createdAt: 0,
          updatedAt: 0,
        });
      });
    } finally {
      await dispose();
    }
  });

  it('rejects persisted melt quote method siblings for one identity', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.table('coco_cashu_melt_quotes').add({
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'duplicate-melt-quote',
        quote: 'duplicate-melt-quote',
        state: 'UNPAID',
        request: 'bolt11-request',
        amount: '1',
        unit: 'sat',
        fee_reserve: '1',
        expiry: 0,
        payment_preimage: null,
        change: undefined,
        lastObservedRemoteState: 'UNPAID',
        lastObservedRemoteStateAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      await expectRejects(async () => {
        await repositories.db.table('coco_cashu_melt_quotes').add({
          mintUrl: 'https://mint.test',
          method: 'bolt12',
          quoteId: 'duplicate-melt-quote',
          quote: 'duplicate-melt-quote',
          state: 'UNPAID',
          request: 'bolt12-request',
          amount: '1',
          unit: 'sat',
          fee_reserve: '1',
          expiry: 0,
          payment_preimage: null,
          change: undefined,
          lastObservedRemoteState: 'UNPAID',
          lastObservedRemoteStateAt: 0,
          createdAt: 0,
          updatedAt: 0,
        });
      });
    } finally {
      await dispose();
    }
  });
});

describe('hydration corruption guard', () => {
  it('rehydrates legacy melt change amounts that lost their prototype', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.table('coco_cashu_melt_quotes').put({
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'legacy-change-amount',
        quote: 'legacy-change-amount',
        state: 'PAID',
        request: 'bolt11-request',
        amount: '10',
        unit: 'sat',
        fee_reserve: '1',
        expiry: 0,
        payment_preimage: 'preimage',
        change: [
          {
            id: 'keyset-1',
            amount: { value: 2n },
            C_: '02'.padEnd(66, '1'),
          },
        ],
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });

      const stored = await repositories.meltQuoteRepository.getMeltQuote(
        'https://mint.test',
        'bolt11',
        'legacy-change-amount',
      );

      expect(stored?.change?.[0]?.amount.equals(Amount.from(2))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when send operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.runTransaction('rw', ['coco_cashu_send_operations'], async (tx) => {
        await tx.table('coco_cashu_send_operations').put({
          id: 'corrupt-send',
          mintUrl: 'https://mint.test',
          amount: 100,
          unit: 'sat',
          state: 'prepared',
          createdAt: 0,
          updatedAt: 0,
          method: 'default',
          methodDataJson: '{}',
          needsSwap: 0,
          fee: null,
          inputAmount: null,
        });
      });

      let threw = false;
      try {
        await repositories.sendOperationRepository.getById('corrupt-send');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when receive operation has prepared state but null fee', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.runTransaction('rw', ['coco_cashu_receive_operations'], async (tx) => {
        await tx.table('coco_cashu_receive_operations').put({
          id: 'corrupt-receive',
          mintUrl: 'https://mint.test',
          amount: 100,
          unit: 'sat',
          state: 'prepared',
          createdAt: 0,
          updatedAt: 0,
          fee: null,
          inputProofsJson: '[]',
        });
      });

      let threw = false;
      try {
        await repositories.receiveOperationRepository.getById('corrupt-receive');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when melt operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.db.runTransaction('rw', ['coco_cashu_melt_operations'], async (tx) => {
        await tx.table('coco_cashu_melt_operations').put({
          id: 'corrupt-melt',
          mintUrl: 'https://mint.test',
          state: 'prepared',
          createdAt: 0,
          updatedAt: 0,
          method: 'bolt11',
          methodDataJson: '{"invoice":"lnbc1test"}',
          quoteId: 'q1',
          amount: null,
          fee_reserve: null,
          swap_fee: null,
          needsSwap: 0,
          inputAmount: null,
        });
      });

      let threw = false;
      try {
        await repositories.meltOperationRepository.getById('corrupt-melt');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });
});
