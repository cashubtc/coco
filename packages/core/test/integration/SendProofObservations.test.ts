import { Database } from 'bun:sqlite';
import { Amount } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { initializeCoco, type Manager } from '../../Manager.ts';
import type { ServiceMap } from '../../plugin.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

// Caller-delivered observations and interrupted local state cannot be arranged through a real mint
// notification on demand. Exercise Manager and its public plugin service with real persistence.
describe.each(['memory', 'sqlite'] as const)(
  'Send proof observations through a Coco Session (%s)',
  (adapter) => {
    let coco: Manager | undefined;
    let database: Database | undefined;
    afterEach(async () => {
      await coco?.dispose();
      coco = undefined;
      database?.close();
      database = undefined;
    });

    async function setup() {
      const repositories: Repositories =
        adapter === 'memory'
          ? new MemoryRepositories()
          : new SqlStorageRepositories({
              database: new SqliteDb({ database: (database = new Database(':memory:')) }),
            });
      await repositories.init();
      let send!: ServiceMap['sendOperationService'];
      coco = await initializeCoco({
        repo: repositories,
        seedGetter: async () => crypto.getRandomValues(new Uint8Array(64)),
        watchers: {
          proofStateWatcher: { disabled: true },
          mintOperationWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
          mintSwapOperationProcessor: { disabled: true },
        },
        plugins: [
          {
            name: 'observations',
            required: ['sendOperationService'],
            onReady: ({ services }) => {
              send = services.sendOperationService;
            },
          },
        ],
      });
      const mintUrl = 'https://mint.test';
      await repositories.mintRepository.addNewMint({
        mintUrl,
        name: 'Test',
        trusted: true,
        mintInfo: testMintInfo,
        createdAt: 1,
        updatedAt: Math.floor(Date.now() / 1000),
      });
      const id = testMintKeysetId();
      await repositories.keysetRepository.addKeyset({
        mintUrl,
        id,
        unit: 'sat',
        active: true,
        feePpk: 0,
        keypairs: testMintKeypairs,
      });
      await repositories.proofRepository.saveProofs(
        mintUrl,
        ['first', 'last'].map((secret) => ({
          mintUrl,
          id,
          unit: 'sat',
          secret,
          C: `C-${secret}`,
          amount: Amount.from(1),
          state: 'ready' as const,
        })),
      );
      const prepared = await coco.ops.send.prepare({ mintUrl, amount: 2 });
      await coco.ops.send.execute(prepared.id);
      return { coco, repositories, send, mintUrl, operationId: prepared.id };
    }

    it('atomically applies the last observation and completion without any background owners', async () => {
      const { coco, repositories, send, mintUrl, operationId } = await setup();
      const finalizations: string[] = [];
      coco.on('send:finalized', ({ operationId }) => {
        finalizations.push(operationId);
      });
      let committedTogether = false;
      coco.on('proofs:state-changed', async ({ secrets }) => {
        if (!secrets.includes('last')) return;
        committedTogether =
          (await coco.ops.send.get(operationId))?.state === 'finalized' &&
          (await repositories.proofRepository.getProofBySecret(mintUrl, 'last'))?.state === 'spent';
      });
      await send.applyProofStateObservation(operationId, ['first']);
      expect((await coco.ops.send.get(operationId))?.state).toBe('pending');
      expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'first'))?.state).toBe(
        'spent',
      );
      await send.applyProofStateObservation(operationId, ['last']);
      await send.applyProofStateObservation(operationId, ['last']);
      expect(committedTogether).toBe(true);
      expect(finalizations).toEqual([operationId]);
      expect(
        (await repositories.proofRepository.getProofBySecret(mintUrl, 'last'))?.usedByOperationId,
      ).toBeUndefined();
    });

    it('reconciles persisted complete evidence and leaves partial evidence pending', async () => {
      const { coco, repositories, send, mintUrl, operationId } = await setup();
      await repositories.proofRepository.setProofState(mintUrl, ['first'], 'spent');
      await send.advancePendingOperation(operationId);
      expect((await coco.ops.send.get(operationId))?.state).toBe('pending');
      await repositories.proofRepository.setProofState(mintUrl, ['last'], 'spent');
      await send.advancePendingOperation(operationId);
      await send.advancePendingOperation(operationId);
      expect((await coco.ops.send.get(operationId))?.state).toBe('finalized');
    });
  },
);
