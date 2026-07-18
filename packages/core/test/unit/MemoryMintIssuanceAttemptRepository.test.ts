import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import type { MintIssuanceAttempt } from '../../operations/mint/MintIssuanceAttempt.ts';
import type { MintOperationRecord } from '../../operations/mint/MintOperation.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

function createAttempt(overrides?: Partial<MintIssuanceAttempt>): MintIssuanceAttempt {
  return {
    id: 'attempt-1',
    mintUrl: 'https://mint.test/',
    method: 'bolt11',
    unit: 'SAT',
    keysetId: 'keyset-1',
    state: 'prepared',
    memberOperationIds: ['operation-1'],
    quoteIds: ['quote-1'],
    quoteAmounts: [Amount.from(1)],
    signingRequirements: [null],
    outputData: {
      keep: [
        {
          blindedMessage: { amount: '1', id: 'keyset-1', B_: 'B_1' },
          blindingFactor: '01',
          secret: '01',
        },
      ],
      send: [],
    },
    counterStart: 7,
    counterEnd: 8,
    request: { kind: 'single', quoteId: 'quote-1' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createOperation(): Extract<MintOperationRecord, { state: 'pending' }> {
  return {
    id: 'operation-1',
    state: 'pending',
    mintUrl: 'https://mint.test',
    quoteId: 'quote-1',
    method: 'bolt11',
    methodData: {},
    createdAt: 1,
    updatedAt: 1,
    amount: Amount.from(1),
    unit: 'sat',
    request: 'lnbc1test',
    expiry: null,
    outputData: { keep: [], send: [] },
  };
}

describe('MemoryMintIssuanceAttemptRepository', () => {
  it('preserves exact durable data and finds recoverable attempts by member', async () => {
    const repositories = new MemoryRepositories();
    const attempt = createAttempt();

    await repositories.mintIssuanceAttemptRepository.create(attempt);

    const byId = await repositories.mintIssuanceAttemptRepository.getById(attempt.id);
    const byMember =
      await repositories.mintIssuanceAttemptRepository.getByMemberOperationId('operation-1');
    const recoverable =
      await repositories.mintIssuanceAttemptRepository.listRecoverable('https://mint.test');
    expect(byId?.mintUrl).toBe('https://mint.test');
    expect(byId?.unit).toBe('sat');
    expect(JSON.stringify(byId?.outputData)).toBe(JSON.stringify(attempt.outputData));
    expect(byMember?.id).toBe(attempt.id);
    expect(recoverable.map((item) => item.id)).toEqual([attempt.id]);
  });

  it('rolls back attempt, member, and counter mutations together', async () => {
    const repositories = new MemoryRepositories();
    const operation = createOperation();
    await repositories.mintOperationRepository.create(operation);
    await repositories.counterRepository.setCounter('https://mint.test', 'keyset-1', 7);

    await expect(
      repositories.withTransaction(async (tx) => {
        await tx.mintIssuanceAttemptRepository.create(createAttempt());
        await tx.mintOperationRepository.update({
          ...operation,
          state: 'executing',
          attemptId: 'attempt-1',
        });
        await tx.counterRepository.setCounter('https://mint.test', 'keyset-1', 8);
        await tx.authSessionRepository.saveSession({
          mintUrl: 'https://mint.test',
          accessToken: 'rolled-back-token',
          expiresAt: 100,
        });
        await tx.proofRepository.saveProofs('https://mint.test', [
          {
            id: 'keyset-1',
            amount: Amount.from(1),
            secret: 'rolled-back-proof',
            C: 'C_rollback',
            mintUrl: 'https://mint.test',
            unit: 'sat',
            state: 'ready',
            createdByAttemptId: 'attempt-1',
          },
        ]);
        throw new Error('changed invariant');
      }),
    ).rejects.toThrow('changed invariant');

    expect(await repositories.mintIssuanceAttemptRepository.getById('attempt-1')).toBe(null);
    expect((await repositories.mintOperationRepository.getById('operation-1'))?.state).toBe(
      'pending',
    );
    expect(
      (await repositories.counterRepository.getCounter('https://mint.test', 'keyset-1'))?.counter,
    ).toBe(7);
    expect(
      await repositories.proofRepository.getProofsByAttemptId('https://mint.test', 'attempt-1'),
    ).toHaveLength(0);
    expect(await repositories.authSessionRepository.getSession('https://mint.test')).toBe(null);
  });

  it('does not erase a concurrent transaction when an earlier transaction rolls back', async () => {
    const repositories = new MemoryRepositories();
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = repositories
      .withTransaction(async (tx) => {
        await tx.counterRepository.setCounter('https://mint.test', 'keyset-1', 1);
        enterFirst();
        await firstRelease;
        throw new Error('roll back first transaction');
      })
      .catch((error: unknown) => error);

    await firstEntered;
    const second = repositories.withTransaction(async (tx) => {
      await tx.counterRepository.setCounter('https://mint.test', 'keyset-1', 7);
    });
    releaseFirst();

    await expect(first).resolves.toBeInstanceOf(Error);
    await second;
    expect(
      (await repositories.counterRepository.getCounter('https://mint.test', 'keyset-1'))?.counter,
    ).toBe(7);
  });

  it('rejects updates that change exact recovery material', async () => {
    const repositories = new MemoryRepositories();
    const attempt = createAttempt();
    await repositories.mintIssuanceAttemptRepository.create(attempt);

    await expect(
      repositories.mintIssuanceAttemptRepository.update({
        ...attempt,
        keysetId: 'different-keyset',
        updatedAt: 2,
      }),
    ).rejects.toThrow('recovery material is immutable');

    expect((await repositories.mintIssuanceAttemptRepository.getById(attempt.id))?.keysetId).toBe(
      'keyset-1',
    );
  });

  it('queries proofs by attempt without removing legacy operation provenance', async () => {
    const repositories = new MemoryRepositories();
    await repositories.proofRepository.saveProofs('https://mint.test', [
      {
        id: 'keyset-1',
        amount: Amount.from(1),
        secret: 'secret-1',
        C: 'C_1',
        mintUrl: 'https://mint.test',
        unit: 'sat',
        state: 'ready',
        createdByAttemptId: 'attempt-1',
        createdByOperationId: 'operation-1',
      },
    ]);

    const proofs = await repositories.proofRepository.getProofsByAttemptId(
      'https://mint.test',
      'attempt-1',
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.createdByOperationId).toBe('operation-1');
  });
});
