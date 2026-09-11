import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Amount } from '@cashu/cashu-ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import type {
  ExecutingSendOperation,
  PendingSendOperation,
} from '../../operations/send/SendOperation.ts';
import type { CoreProof } from '../../types.ts';

describe('CoreTransaction with SQLite', () => {
  const legacyScenarios = [
    'exact',
    'swap',
    'conflict',
    'pending-exact',
    'pending-swap',
    'tokenless-p2pk',
    'tokenless-conflict',
  ] as const;
  it.each([...legacyScenarios])(
    'recovers legacy Send persistence atomically (%s)',
    async (scenario) => {
      const database = new Database(':memory:');
      const repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      await repositories.init();
      const transactions = new CoreSendTransactions(
        new RepositoryCoreTransactionRunner(repositories),
      );
      const mintUrl = 'https://mint.test';
      const amount = Amount.from(10);
      const tokenless = scenario === 'tokenless-p2pk' || scenario === 'tokenless-conflict';
      const needsSwap = scenario === 'swap' || scenario === 'pending-swap' || tokenless;
      const pending = scenario === 'pending-exact' || scenario === 'pending-swap' || tokenless;
      const input: CoreProof = {
        id: 'keyset',
        secret: 'input',
        C: 'C-input',
        amount,
        mintUrl,
        unit: 'sat',
        state: needsSwap || pending ? 'spent' : 'inflight',
        usedByOperationId: pending && !tokenless ? undefined : 'legacy',
      };
      const send: CoreProof = {
        ...input,
        secret: 'output',
        C: 'C-output',
        state: pending ? 'spent' : 'inflight',
        usedByOperationId: undefined,
        createdByOperationId: 'legacy',
      };
      const operation: ExecutingSendOperation | PendingSendOperation = {
        id: 'legacy',
        state: pending ? 'pending' : 'executing',
        amount,
        mintUrl,
        unit: 'sat',
        method: tokenless ? 'p2pk' : 'default',
        methodData: tokenless ? { pubkey: 'pubkey' } : {},
        createdAt: 1000,
        updatedAt: 1000,
        needsSwap,
        inputProofSecrets: [input.secret],
        inputAmount: amount,
        fee: Amount.zero(),
        outputData: needsSwap
          ? {
              keep: [],
              send: [
                {
                  blindedMessage: { id: send.id, amount: 10, B_: 'B-output' },
                  secret: Buffer.from(send.secret).toString('hex'),
                  blindingFactor: '01',
                },
              ],
            }
          : undefined,
        ...(pending && !tokenless
          ? { token: { mint: mintUrl, unit: 'sat', proofs: needsSwap ? [send] : [input] } }
          : {}),
      };
      try {
        await repositories.sendOperationRepository.create(operation);
        await repositories.proofRepository.saveProofs(
          mintUrl,
          needsSwap && !tokenless ? [input, send] : [input],
        );
        if (pending) {
          const completion = {
            operationId: operation.id,
            updatedAt: 2000,
            ...(tokenless
              ? {
                  spentProofSecrets: [send.secret],
                  legacyP2pkOutputObservation: {
                    expectedRevision: 0,
                    mintUrl,
                    unit: 'sat',
                    outputData: operation.outputData!,
                  },
                }
              : {}),
          };
          if (scenario === 'tokenless-conflict') {
            database.exec(`
              CREATE TRIGGER reject_completion BEFORE UPDATE ON coco_cashu_send_operations
              WHEN NEW.state = 'finalized'
              BEGIN SELECT RAISE(ABORT, 'completion failed'); END;
            `);
            await expect(transactions.completePending(completion)).rejects.toThrow(
              'completion failed',
            );
            expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
              'pending',
            );
            expect(
              await repositories.proofRepository.getProofBySecret(mintUrl, input.secret),
            ).toMatchObject(input);
            return;
          }
          const result = await transactions.completePending(completion);
          expect(result.releasedInputSecrets).toEqual(tokenless ? [input.secret] : []);
          if (tokenless) {
            expect(result.operation.token).toBeUndefined();
            expect(
              await repositories.proofRepository.getProofBySecret(mintUrl, send.secret),
            ).toBeNull();
          }
          expect(await repositories.sendOperationRepository.getById(operation.id)).toMatchObject({
            state: 'finalized',
            revision: 1,
          });
          expect(
            (await repositories.proofRepository.getProofBySecret(mintUrl, input.secret))?.state,
          ).toBe('spent');
        } else if (scenario === 'swap') {
          const storedSend = await repositories.proofRepository.getProofBySecret(
            mintUrl,
            send.secret,
          );
          await transactions.claimRecovery({
            operationId: operation.id,
            expectedRevision: 0,
            updatedAt: 2000,
          });
          const result = await transactions.applyResult({
            operationId: operation.id,
            updatedAt: 3000,
            keepProofs: [],
            sendProofs: [send],
            token: { mint: mintUrl, unit: 'sat', proofs: [send] },
          });
          expect(result.operation.state).toBe('pending');
          expect(result.savedProofs).toEqual([]);
          expect(await repositories.proofRepository.getProofBySecret(mintUrl, send.secret)).toEqual(
            storedSend,
          );
          expect(
            (await repositories.proofRepository.getProofBySecret(mintUrl, input.secret))
              ?.usedByOperationId,
          ).toBe(operation.id);
        } else if (scenario === 'conflict') {
          database.exec(`
            CREATE TRIGGER reject_recovery BEFORE UPDATE ON coco_cashu_send_operations
            WHEN NEW.state = 'rolled_back'
            BEGIN SELECT RAISE(ABORT, 'recovery failed'); END;
          `);
          await expect(
            transactions.recoverLegacyExact({ operationId: operation.id, updatedAt: 2000 }),
          ).rejects.toThrow('recovery failed');
          expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
            'executing',
          );
          expect(
            await repositories.proofRepository.getProofBySecret(mintUrl, input.secret),
          ).toMatchObject(input);
        } else {
          await transactions.recoverLegacyExact({ operationId: operation.id, updatedAt: 2000 });
          expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
            'rolled_back',
          );
          const available = await repositories.proofRepository.getAvailableProofs(mintUrl);
          expect(available).toHaveLength(1);
          expect(available[0]?.secret).toBe(input.secret);
          expect(available[0]?.usedByOperationId).toBeUndefined();
        }
      } finally {
        database.close();
      }
    },
  );

  it('rolls back allocation when an independent sibling import fails', async () => {
    const database = new Database(':memory:');
    const repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    await repositories.init();
    const derivation = new KeypairDerivation(async () => new Uint8Array(64));
    const input = await derivation.prepare('nut20_mint_quote');
    const importDeriver = await derivation.prepare('p2pk');
    const imported = { ...importDeriver.derive(100), purpose: 'p2pk' as const };
    database.exec(`
      CREATE TRIGGER reject_import BEFORE INSERT ON coco_cashu_keypairs
      WHEN NEW.publicKey = '${imported.publicKeyHex}'
      BEGIN SELECT RAISE(ABORT, 'import failed'); END;
    `);
    const runner = new RepositoryCoreTransactionRunner(repositories);
    let pending: Promise<unknown>[] = [];

    try {
      await expect(
        runner.run((scope) => {
          pending = [scope.keypairs.allocate(input), scope.keypairs.importP2pk(imported)];
          return Promise.all(pending);
        }),
      ).rejects.toThrow('import failed');

      await Promise.allSettled(pending);
      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(0);
      expect(
        await repositories.keyRingRepository.getAllPersistedKeyPairs('nut20_mint_quote'),
      ).toHaveLength(0);
      expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
      expect(
        await repositories.keyRingRepository.getLastAllocatedIndex('nut20_mint_quote'),
      ).toBeNull();
      await expect(runner.run((scope) => scope.keypairs.allocate(input))).resolves.toMatchObject({
        derivationIndex: 0,
      });
    } finally {
      await Promise.allSettled(pending);
      database.close();
    }
  });
});
