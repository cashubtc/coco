import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { initializeCoco, type Manager } from '../../Manager.ts';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import { installMintSwapProtocol, mintSwapRuntimeConfig } from '../fixtures/MintSwapRuntime.ts';

describe('Mint Swap runtime persistent restart', () => {
  afterEach(() => {
    mock.restore();
  });
  for (const paid of [true, false]) {
    it(`recovers with default processing across store reopen (${paid ? 'PAID' : 'UNPAID'})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mint-swap-runtime-'));
      const path = join(dir, 'wallet.sqlite');
      let database = new Database(path);
      let manager: Manager | undefined;
      try {
        spyOn(Date, 'now').mockReturnValue(10_000);
        let repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
        let fixture = await mintSwapFixture(repo);
        installMintSwapProtocol(fixture);
        await fixture.create();
        await fixture.prepare();
        fixture.setSourceState('PENDING');
        manager = await initializeCoco({
          repo,
          seedGetter: fixture.dependencies.loadSeed,
          ...mintSwapRuntimeConfig,
          processors: {
            ...mintSwapRuntimeConfig.processors,
            mintSwapOperationProcessor: { disabled: true },
          },
        });
        await manager.ops.mintSwap.execute('swap');
        await manager.ops.mintSwap.cancel('swap');
        const original = await manager.ops.mintSwap.get('swap');
        expect(original?.state).toBe('source_pending');
        await manager.dispose();
        manager = undefined;
        database.close();
        mock.restore();

        database = new Database(path);
        repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
        fixture = await mintSwapFixture(repo, { initialize: false });
        spyOn(Date, 'now').mockReturnValue(30_000);
        fixture.setTime(30_000);
        fixture.setSourceState(paid ? 'PAID' : 'UNPAID');
        fixture.setDestinationState('ISSUED');
        installMintSwapProtocol(fixture);
        manager = await initializeCoco({
          repo,
          seedGetter: fixture.dependencies.loadSeed,
          ...mintSwapRuntimeConfig,
          processors: {
            mintOperationProcessor: {},
            meltSettlementProcessor: {},
            mintSwapOperationProcessor: { disabled: true },
          },
        });
        expect(await manager.ops.mintSwap.get('swap')).toEqual(original);
        expect((await manager.ops.melt.get('source-child'))?.state).toBe('pending');
        expect(fixture.requests).toEqual([]);
        await expect(manager.ops.melt.refresh('source-child')).rejects.toMatchObject({
          name: 'MintSwapChildOperationError',
          parentOperationId: 'swap',
        });
        await manager.enableMintSwapOperationProcessor();
        const recovered = await manager.ops.mintSwap.get('swap');
        expect(recovered?.state).toBe(paid ? 'completed' : 'cancelled');
        expect(recovered?.sourceOperationId).toBe(original?.sourceOperationId);
        expect(recovered?.destinationOperationId).toBe(original?.destinationOperationId);
        expect(recovered?.cancellationRequestedAt).toBe(original?.cancellationRequestedAt);
        expect(fixture.requests).not.toContain('melt');
      } finally {
        await manager?.dispose();
        database.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
