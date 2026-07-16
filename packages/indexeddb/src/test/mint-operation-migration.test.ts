import { describe, expect, it } from 'vitest';
import { IndexedDbRepositories } from '../index.ts';
import { IdbDb } from '../lib/db.ts';

const VERSION_32_STORES = {
  coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
  coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
  coco_cashu_counters: '&[mintUrl+keysetId]',
  coco_cashu_proofs:
    '&[mintUrl+secret], [mintUrl+state], [mintUrl+unit+state], [mintUrl+id+state], [mintUrl+id+unit+state], [mintUrl+unit+id+state], [unit+state], [mintUrl+createdByAttemptId], state, mintUrl, unit, id, usedByOperationId, createdByOperationId, createdByAttemptId',
  coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
  coco_cashu_canonical_mint_quotes:
    '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
  coco_cashu_melt_quotes: '&[mintUrl+method+quoteId], &[mintUrl+quoteId], state, mintUrl, method',
  coco_cashu_history:
    '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type], [mintUrl+operationId]',
  coco_cashu_keypairs: '&publicKey, createdAt, derivationIndex',
  coco_cashu_send_operations: '&id, state, mintUrl, createdAt',
  coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
  coco_cashu_receive_operations: '&id, state, mintUrl, createdAt',
  coco_cashu_auth_sessions: '&mintUrl',
  coco_cashu_mint_operations:
    '&id, state, mintUrl, createdAt, attemptId, [mintUrl+quoteId], [mintUrl+method+quoteId]',
  coco_cashu_mint_issuance_attempts:
    '&id, state, mintUrl, createdAt, *memberOperationIds, [mintUrl+state]',
  coco_cashu_payment_request_receive_operations: '&id, state, requestId',
  coco_cashu_payment_request_receive_attempts:
    '&id, requestOperationId, requestId, state, &[requestOperationId+payloadHash], [requestId+payloadHash], &transportMessageId, &receiveOperationId',
};

const legacyMintOutput = (suffix: string, keysetId = 'legacy-keyset') => ({
  keep: [
    {
      blindedMessage: { amount: '1', id: keysetId, B_: `B_${suffix}` },
      blindingFactor: '1',
      secret: Array.from(suffix, (character) =>
        character.charCodeAt(0).toString(16).padStart(2, '0'),
      ).join(''),
    },
  ],
  send: [],
});

async function seedVersion32(name: string, corruptPendingOutput = false): Promise<void> {
  const db = new IdbDb({ name });
  db.version(32).stores(VERSION_32_STORES);
  await db.open();
  await db.table('coco_cashu_counters').add({
    mintUrl: 'https://mint.test',
    keysetId: 'legacy-keyset',
    counter: 14,
  });
  await db.table('coco_cashu_proofs').add({
    mintUrl: 'https://mint.test',
    id: 'legacy-keyset',
    unit: 'sat',
    amount: '1',
    secret: 'legacy-proof',
    C: 'C_legacy',
    state: 'ready',
    createdAt: 1,
    createdByOperationId: 'finalized-op',
    createdByAttemptId: null,
  });
  const rows = [
    { id: 'init-op', state: 'init', createdAt: 1, outputDataJson: null },
    {
      id: 'pending-op',
      state: 'pending',
      createdAt: 2,
      outputDataJson: corruptPendingOutput ? '{' : JSON.stringify(legacyMintOutput('pending')),
    },
    {
      id: 'executing-op',
      state: 'executing',
      createdAt: 3,
      outputDataJson: JSON.stringify(legacyMintOutput('executing')),
    },
    {
      id: 'finalized-op',
      state: 'finalized',
      createdAt: 4,
      outputDataJson: JSON.stringify(legacyMintOutput('finalized')),
    },
    {
      id: 'failed-op',
      state: 'failed',
      createdAt: 5,
      outputDataJson: JSON.stringify(legacyMintOutput('failed')),
    },
    {
      id: 'bolt12-executing-op',
      state: 'executing',
      createdAt: 6,
      outputDataJson: JSON.stringify(legacyMintOutput('bolt12-executing')),
    },
  ];
  await db.table('coco_cashu_mint_operations').bulkAdd(
    rows.map((row) => ({
      ...row,
      mintUrl: 'https://mint.test',
      quoteId: `quote-${row.id}`,
      updatedAt: row.createdAt + 10,
      error: row.state === 'failed' ? 'quote expired' : null,
      method: row.id === 'bolt12-executing-op' ? 'bolt12' : 'bolt11',
      methodDataJson: '{}',
      amount: '1',
      unit: 'sat',
      request: 'lnbc1legacy',
      expiry: 1_730_000_000,
      terminalFailureJson:
        row.state === 'failed'
          ? JSON.stringify({
              reason: 'quote expired',
              code: 'QUOTE_EXPIRED',
              retryable: false,
              observedAt: 15_000,
            })
          : null,
      attemptId: null,
    })),
  );
  db.close();
}

describe('legacy Mint Operation IndexedDB migration', () => {
  it('upgrades version 32 operations transactionally and remains idempotent on restart', async () => {
    const name = `coco_mint_operation_migration_${crypto.randomUUID()}`;
    await seedVersion32(name);
    const repositories = new IndexedDbRepositories({ name });
    try {
      await repositories.init();
      const attempts = await repositories.db
        .table('coco_cashu_mint_issuance_attempts')
        .orderBy('createdAt')
        .toArray();
      expect(attempts.map((attempt) => attempt.state)).toEqual([
        'prepared',
        'recovering',
        'succeeded',
        'failed',
        'recovering',
      ]);
      expect(attempts.map((attempt) => [attempt.counterStart, attempt.counterEnd])).toEqual([
        [null, null],
        [null, null],
        [null, null],
        [null, null],
        [null, null],
      ]);
      expect(attempts.every((attempt) => attempt.counterRangeKnown === false)).toBe(true);
      const hydrated = await repositories.mintIssuanceAttemptRepository.getById(
        'legacy-mint-operation:pending-op',
      );
      expect(hydrated?.counterStart).toBeUndefined();
      expect(hydrated?.counterEnd).toBeUndefined();
      expect(attempts[0]).toMatchObject({
        id: 'legacy-mint-operation:pending-op',
        memberOperationIds: ['pending-op'],
        quoteIdsJson: '["quote-pending-op"]',
        outputDataJson: JSON.stringify(legacyMintOutput('pending')),
      });

      const pending = await repositories.db.table('coco_cashu_mint_operations').get('pending-op');
      expect(pending).toMatchObject({
        state: 'executing',
        attemptId: 'legacy-mint-operation:pending-op',
      });
      expect(
        await repositories.counterRepository.getCounter('https://mint.test', 'legacy-keyset'),
      ).toMatchObject({ counter: 14 });
      expect(
        await repositories.db.table('coco_cashu_proofs').get(['https://mint.test', 'legacy-proof']),
      ).toMatchObject({
        createdByOperationId: 'finalized-op',
        createdByAttemptId: null,
      });

      repositories.db.close();
      const restarted = new IndexedDbRepositories({ name });
      await restarted.init();
      expect(await restarted.db.table('coco_cashu_mint_issuance_attempts').count()).toBe(5);
      restarted.db.close();
    } finally {
      repositories.db.close();
      await repositories.db.delete();
    }
  });

  it('rolls back a failed upgrade and resumes after corrupt legacy output JSON is repaired', async () => {
    const name = `coco_mint_operation_resume_${crypto.randomUUID()}`;
    await seedVersion32(name, true);
    const failing = new IndexedDbRepositories({ name });
    try {
      await expect(failing.init()).rejects.toThrow('invalid outputDataJson');
      failing.db.close();

      const repair = new IdbDb({ name });
      repair.version(32).stores(VERSION_32_STORES);
      await repair.open();
      expect(await repair.table('coco_cashu_mint_issuance_attempts').count()).toBe(0);
      expect(await repair.table('coco_cashu_mint_operations').get('pending-op')).toMatchObject({
        state: 'pending',
        attemptId: null,
      });
      await repair.table('coco_cashu_mint_operations').update('pending-op', {
        outputDataJson: JSON.stringify(legacyMintOutput('pending')),
      });
      repair.close();

      const resumed = new IndexedDbRepositories({ name });
      await resumed.init();
      expect(await resumed.db.table('coco_cashu_mint_issuance_attempts').count()).toBe(5);
      resumed.db.close();
    } finally {
      failing.db.close();
      await failing.db.delete();
    }
  });
});
