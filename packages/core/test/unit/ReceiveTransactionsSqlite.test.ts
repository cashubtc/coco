import { Amount, OutputData } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { createReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import { mapProofToCoreProof } from '../../utils.ts';
import { keys, metadata, mintUrl, inputProof, seed } from '../fixtures/ProtocolMint.ts';
import { receivedProofs } from '../fixtures/ReceiveRemote.ts';

async function environment() {
  const database = new Database(':memory:');
  const repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
  await repositories.init();
  await repositories.mintRepository.addOrUpdateMint(metadata.mint);
  await repositories.keysetRepository.addKeyset(metadata.keysets[0]!);
  const gateway = () =>
    new CoreReceiveTransactions(new RepositoryCoreTransactionRunner(repositories));
  const command = (id: string) => ({
    operation: createReceiveOperation(id, mintUrl, { amount: Amount.from(16), unit: 'sat' }, [
      inputProof(),
    ]),
    activeKeys: keys,
    seed,
  });
  return { database, repositories, gateway, command };
}

describe('ReceiveTransactions with SQLite', () => {
  it('rolls back allocated counters when prepared persistence fails', async () => {
    const { database, repositories, gateway, command } = await environment();
    try {
      database.exec(
        `CREATE TRIGGER reject_receive BEFORE INSERT ON coco_cashu_receive_operations BEGIN SELECT RAISE(ABORT, 'receive insert failed'); END;`,
      );
      await expect(gateway().prepare(command('failed-prepare'))).rejects.toThrow(
        'receive insert failed',
      );
      expect(await repositories.counterRepository.getCounter(mintUrl, keys.id)).toBeNull();
      expect(await repositories.receiveOperationRepository.getById('failed-prepare')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('rolls back issued proofs when conditional finalization fails', async () => {
    const { database, repositories, gateway, command } = await environment();
    try {
      const transactions = gateway();
      const prepared = await transactions.prepare(command('failed-apply'));
      await transactions.beginExecution({ operationId: prepared.operation.id, updatedAt: 2000 });
      database.exec(
        `CREATE TRIGGER reject_finalization BEFORE UPDATE ON coco_cashu_receive_operations WHEN NEW.state = 'finalized' BEGIN SELECT RAISE(ABORT, 'finalize failed'); END;`,
      );
      const proofs = mapProofToCoreProof(
        mintUrl,
        'ready',
        receivedProofs(prepared.operation.outputData),
        { unit: 'sat', createdByOperationId: prepared.operation.id },
      );
      await expect(
        transactions.applyResult({ operationId: prepared.operation.id, updatedAt: 3000, proofs }),
      ).rejects.toThrow('finalize failed');
      expect(
        await repositories.proofRepository.getProofsByOperationId(mintUrl, prepared.operation.id),
      ).toEqual([]);
      expect(
        (await repositories.receiveOperationRepository.getById(prepared.operation.id))?.state,
      ).toBe('executing');
    } finally {
      database.close();
    }
  });

  it('serializes allocation and conditional authorization across independent runners', async () => {
    const { database, repositories, gateway, command } = await environment();
    try {
      const first = gateway();
      const second = gateway();
      const prepared = await Promise.all([
        first.prepare(command('a')),
        second.prepare(command('b')),
      ]);
      const outputs = prepared.flatMap((result) => result.operation.outputData.keep);
      expect(new Set(outputs.map((output) => output.secret)).size).toBe(outputs.length);
      expect((await repositories.counterRepository.getCounter(mintUrl, keys.id))?.counter).toBe(
        outputs.length,
      );
      const expected = OutputData.createDeterministicData(Amount.from(16), seed, 0, keys);
      expect(outputs[0]!.blindedMessage.B_).toBe(expected[0]!.blindedMessage.B_);
      const results = await Promise.allSettled([
        first.beginExecution({ operationId: 'a', updatedAt: 2000 }),
        second.beginExecution({ operationId: 'a', updatedAt: 2000 }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await repositories.receiveOperationRepository.getById('a'))?.revision).toBe(1);
    } finally {
      database.close();
    }
  });
});
