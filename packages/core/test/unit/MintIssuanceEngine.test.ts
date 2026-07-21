import {
  Amount,
  OutputData,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote.ts';
import { MintScopedLock } from '../../operations/MintScopedLock.ts';
import { MintIssuanceEngine } from '../../operations/mint/MintIssuanceEngine.ts';
import type { PendingMintOperation } from '../../operations/mint/MintOperation.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { CounterService } from '../../services/CounterService.ts';
import { ProofService } from '../../services/ProofService.ts';
import { SeedService } from '../../services/SeedService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';
import { ScriptedMintIssuanceTransport } from '../fixtures/ScriptedMintIssuanceTransport.ts';

describe('MintIssuanceEngine', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';
  const keysetId = 'keyset-1';
  const now = 1_000;

  let repositories: MemoryRepositories;
  let eventBus: EventBus<CoreEvents>;
  let proofService: ProofService;
  let walletService: WalletService;
  let originalToProof: typeof OutputData.prototype.toProof;

  const pendingOperation = (): PendingMintOperation<'bolt11'> => ({
    id: 'mint-op-1',
    mintUrl,
    method: 'bolt11',
    methodData: {},
    state: 'pending',
    quoteId,
    amount: Amount.from(10),
    unit: 'sat',
    request: 'lnbc1test',
    expiry: 10_000,
    outputData: { keep: [], send: [] },
    createdAt: now,
    updatedAt: now,
  });

  const validSignature = (): SerializedBlindedSignature => ({
    id: keysetId,
    amount: Amount.from(10),
    C_: 'C_1',
    dleq: { e: '01', s: '02' },
  });

  function makeEngine(
    transport: ScriptedMintIssuanceTransport,
    options: { proofService?: ProofService; mintScopedLock?: MintScopedLock } = {},
  ): MintIssuanceEngine {
    return new MintIssuanceEngine({
      repositories,
      proofService: options.proofService ?? proofService,
      walletService,
      transport,
      eventBus,
      mintScopedLock: options.mintScopedLock,
    });
  }

  beforeEach(async () => {
    repositories = new MemoryRepositories();
    eventBus = new EventBus<CoreEvents>();
    originalToProof = OutputData.prototype.toProof;
    OutputData.prototype.toProof = mock(function (): Proof {
      return {
        id: keysetId,
        amount: Amount.from(10),
        secret: 'secret-0',
        C: 'C_1',
        dleq: { e: '01', s: '02', r: '03' },
      } as Proof;
    });

    walletService = {
      async getWalletWithActiveKeysetId() {
        return { keys: { id: keysetId }, keysetId };
      },
    } as never;
    const mintService = {
      async ensureUpdatedMint() {
        return {
          mint: {},
          keysets: [
            {
              id: keysetId,
              unit: 'sat',
              keypairs: {},
              active: true,
              feePpk: 0,
              mintUrl,
              updatedAt: now,
            },
          ],
        };
      },
    };
    const outputDataCreator = makeOutputDataCreator({
      createDeterministicData(amount, _seed, counter, keys) {
        return [
          new OutputData(
            { amount: Amount.from(amount), id: keys.id, B_: `B_${counter}` },
            BigInt(counter + 1),
            new TextEncoder().encode(`secret-${counter}`),
          ),
        ] as OutputDataLike[];
      },
    });
    proofService = new ProofService(
      new CounterService(repositories.counterRepository),
      repositories.proofRepository,
      walletService,
      mintService as never,
      {} as never,
      new SeedService(async () => new Uint8Array(64).fill(7)),
      undefined,
      eventBus,
      outputDataCreator,
    );

    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Test mint',
      mintInfo: {} as never,
      trusted: true,
      createdAt: now,
      updatedAt: now,
    });
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: 10_000,
        state: 'PAID',
      }),
    );
    await repositories.mintOperationRepository.create(pendingOperation());
  });

  afterEach(() => {
    OutputData.prototype.toProof = originalToProof;
  });

  it('issues one eligible BOLT11 Mint Operation through one durable attempt', async () => {
    const transport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);
    const engine = makeEngine(transport);

    const issued = await engine.issueCandidates([pendingOperation()]);

    expect(issued).toHaveLength(1);
    expect(issued[0]?.state).toBe('finalized');
    const attempts = await repositories.mintIssuanceAttemptRepository.listIncomplete(mintUrl);
    expect(attempts).toHaveLength(0);
    const attempt =
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
    expect(attempt?.state).toBe('succeeded');
    expect(attempt?.members).toEqual([
      { operationId: 'mint-op-1', quoteId, amount: Amount.from(10) },
    ]);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.quoteId).toBe(quoteId);
    expect(transport.requests[0]?.outputs).toHaveLength(1);
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toEqual({
      mintUrl,
      keysetId,
      counter: 1,
    });
    const proofs = await repositories.proofRepository.getReadyProofs(mintUrl, { unit: 'sat' });
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.createdByMintIssuanceAttemptId).toBe(attempt?.id);
    expect(proofs[0]?.createdByOperationId).toBeUndefined();
  });

  it('marks the attempt submitted before dispatch and preserves ambiguity on transport failure', async () => {
    const transportError = new Error('connection reset after request write');
    const transport = new ScriptedMintIssuanceTransport([
      {
        kind: 'run',
        run: async () => {
          const attempt =
            await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId(
              'mint-op-1',
            );
          expect(attempt?.state).toBe('submitted');
          throw transportError;
        },
      },
    ]);

    await expect(makeEngine(transport).issueCandidates([pendingOperation()])).rejects.toBe(
      transportError,
    );

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
    const operation = await repositories.mintOperationRepository.getById('mint-op-1');
    expect(attempt?.state).toBe('submitted');
    expect(operation?.state).toBe('executing');
    expect(operation?.mintIssuanceAttemptId).toBe(attempt?.id);
    expect(await repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
  });

  it('recovers one prepared attempt through the same issuance seam', async () => {
    const transition = Object.getPrototypeOf(repositories.mintIssuanceAttemptRepository)
      .compareAndTransition as typeof repositories.mintIssuanceAttemptRepository.compareAndTransition;
    let interruptSubmission = true;
    repositories.mintIssuanceAttemptRepository.compareAndTransition = async function (
      attemptId,
      next,
    ) {
      if (interruptSubmission && next.to === 'submitted') {
        throw new Error('interrupted after prepare commit');
      }
      return transition.call(this, attemptId, next);
    };
    const interruptedTransport = new ScriptedMintIssuanceTransport([]);
    await expect(
      makeEngine(interruptedTransport).issueCandidates([pendingOperation()]),
    ).rejects.toThrow('interrupted after prepare commit');
    const prepared =
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
    expect(prepared?.state).toBe('prepared');

    interruptSubmission = false;
    const recoveryTransport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);

    const recovered = await makeEngine(recoveryTransport).recoverAttempt(prepared!);

    expect(recovered[0]?.state).toBe('finalized');
    expect(recoveryTransport.requests[0]?.outputs[0]?.B_).toBe(
      prepared?.outputData.keep[0]?.blindedMessage.B_,
    );
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toEqual({
      mintUrl,
      keysetId,
      counter: 1,
    });
  });

  it('does not recover a prepared attempt after its mint is untrusted', async () => {
    const transition = Object.getPrototypeOf(repositories.mintIssuanceAttemptRepository)
      .compareAndTransition as typeof repositories.mintIssuanceAttemptRepository.compareAndTransition;
    let interruptSubmission = true;
    repositories.mintIssuanceAttemptRepository.compareAndTransition = async function (
      attemptId,
      next,
    ) {
      if (interruptSubmission && next.to === 'submitted') {
        throw new Error('interrupted after prepare commit');
      }
      return transition.call(this, attemptId, next);
    };
    await expect(
      makeEngine(new ScriptedMintIssuanceTransport([])).issueCandidates([pendingOperation()]),
    ).rejects.toThrow('interrupted after prepare commit');
    const prepared =
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
    expect(prepared?.state).toBe('prepared');
    interruptSubmission = false;
    await repositories.mintRepository.setMintTrusted(mintUrl, false);
    const recoveryTransport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);

    await expect(makeEngine(recoveryTransport).recoverAttempt(prepared!)).rejects.toThrow(
      `Mint ${mintUrl} is no longer trusted`,
    );

    expect(recoveryTransport.requests).toHaveLength(0);
    expect(
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1'),
    ).toEqual(prepared);
    expect((await repositories.mintOperationRepository.getById('mint-op-1'))?.state).toBe(
      'executing',
    );
  });

  it.each([
    ['wrong signature count', []],
    ['wrong amount', [{ ...validSignature(), amount: Amount.from(9) }]],
    ['wrong keyset', [{ ...validSignature(), id: 'other-keyset' }]],
    ['missing DLEQ', [{ ...validSignature(), dleq: undefined }]],
  ] as const)(
    'keeps a submitted attempt intact for %s',
    async (_name, signatures: readonly SerializedBlindedSignature[]) => {
      const transport = new ScriptedMintIssuanceTransport([
        { kind: 'return', signatures: [...signatures] },
      ]);

      await expect(makeEngine(transport).issueCandidates([pendingOperation()])).rejects.toThrow();

      const attempt =
        await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
      expect(attempt?.state).toBe('submitted');
      expect(await repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
      expect((await repositories.mintOperationRepository.getById('mint-op-1'))?.state).toBe(
        'executing',
      );
    },
  );

  it('keeps a submitted attempt intact when proof conversion fails', async () => {
    OutputData.prototype.toProof = mock(() => {
      throw new Error('invalid DLEQ proof');
    });
    const transport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);

    await expect(makeEngine(transport).issueCandidates([pendingOperation()])).rejects.toThrow(
      'invalid DLEQ proof',
    );

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
    expect(attempt?.state).toBe('submitted');
    expect(await repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
  });

  it('leaves no durable reservation when local output construction fails', async () => {
    const constructionError = new Error('output construction failed');
    const failingProofService = new ProofService(
      new CounterService(repositories.counterRepository),
      repositories.proofRepository,
      walletService,
      {
        async ensureUpdatedMint() {
          return { mint: {}, keysets: [] };
        },
      } as never,
      {} as never,
      new SeedService(async () => new Uint8Array(64).fill(7)),
      undefined,
      eventBus,
      makeOutputDataCreator({
        createDeterministicData() {
          throw constructionError;
        },
      }),
    );
    const transport = new ScriptedMintIssuanceTransport([]);

    await expect(
      makeEngine(transport, { proofService: failingProofService }).issueCandidates([
        pendingOperation(),
      ]),
    ).rejects.toBe(constructionError);

    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1'),
    ).toBeNull();
    expect((await repositories.mintOperationRepository.getById('mint-op-1'))?.state).toBe(
      'pending',
    );
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects malformed aggregate outputs before reserving counters', async () => {
    const malformedProofService = new ProofService(
      new CounterService(repositories.counterRepository),
      repositories.proofRepository,
      walletService,
      {
        async ensureUpdatedMint() {
          return { mint: {}, keysets: [] };
        },
      } as never,
      {} as never,
      new SeedService(async () => new Uint8Array(64).fill(7)),
      undefined,
      eventBus,
      makeOutputDataCreator({
        createDeterministicData(_amount, _seed, counter, keys) {
          return [
            new OutputData(
              { amount: Amount.from(9), id: keys.id, B_: `B_${counter}` },
              BigInt(counter + 1),
              new TextEncoder().encode(`secret-${counter}`),
            ),
          ];
        },
      }),
    );
    const transport = new ScriptedMintIssuanceTransport([]);

    await expect(
      makeEngine(transport, { proofService: malformedProofService }).issueCandidates([
        pendingOperation(),
      ]),
    ).rejects.toThrow('aggregate amount');

    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1'),
    ).toBeNull();
    expect(transport.requests).toHaveLength(0);
  });

  it('rolls proof, quote, operation, and success persistence back atomically', async () => {
    const transition = repositories.mintIssuanceAttemptRepository.compareAndTransition.bind(
      repositories.mintIssuanceAttemptRepository,
    );
    repositories.mintIssuanceAttemptRepository.compareAndTransition = async (attemptId, next) => {
      if (next.to === 'succeeded') throw new Error('final commit interrupted');
      return transition(attemptId, next);
    };
    const transport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);

    await expect(makeEngine(transport).issueCandidates([pendingOperation()])).rejects.toThrow(
      'final commit interrupted',
    );

    const attempt =
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1');
    const quote = await repositories.mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', quoteId);
    expect(attempt?.state).toBe('submitted');
    expect((await repositories.mintOperationRepository.getById('mint-op-1'))?.state).toBe(
      'executing',
    );
    expect(quote?.state).toBe('PAID');
    expect(await repositories.proofRepository.getReadyProofs(mintUrl)).toHaveLength(0);
  });

  it('does not enter the engine for a NUT-20 locked operation', async () => {
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: 'lnbc1test',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: 10_000,
        pubkey: '02'.padEnd(66, '1'),
        state: 'PAID',
      }),
    );
    const transport = new ScriptedMintIssuanceTransport([]);

    await expect(makeEngine(transport).issueCandidates([pendingOperation()])).resolves.toEqual([]);

    expect(transport.requests).toHaveLength(0);
    expect(
      await repositories.mintIssuanceAttemptRepository.getNewestByMemberOperationId('mint-op-1'),
    ).toBeNull();
  });

  it('creates at most one attempt from one candidate invocation', async () => {
    const second = { ...pendingOperation(), id: 'mint-op-2', quoteId: 'quote-2', createdAt: 2_000 };
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: second.quoteId,
        request: 'lnbc1second',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: 10_000,
        state: 'PAID',
      }),
    );
    await repositories.mintOperationRepository.create(second);
    const transport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);

    const issued = await makeEngine(transport).issueCandidates([pendingOperation(), second]);

    expect(issued.map((operation) => operation.id)).toEqual(['mint-op-1']);
    expect((await repositories.mintOperationRepository.getById(second.id))?.state).toBe('pending');
    expect(transport.requests).toHaveLength(1);
  });

  it('blocks a second attempt while the mint has an incomplete attempt', async () => {
    const firstTransportError = new Error('ambiguous first submission');
    const firstTransport = new ScriptedMintIssuanceTransport([
      { kind: 'throw', error: firstTransportError },
    ]);
    await expect(makeEngine(firstTransport).issueCandidates([pendingOperation()])).rejects.toBe(
      firstTransportError,
    );

    const second = { ...pendingOperation(), id: 'mint-op-2', quoteId: 'quote-2', createdAt: 2_000 };
    await repositories.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: second.quoteId,
        request: 'lnbc1second',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: 10_000,
        state: 'PAID',
      }),
    );
    await repositories.mintOperationRepository.create(second);
    const secondTransport = new ScriptedMintIssuanceTransport([]);

    await expect(makeEngine(secondTransport).issueCandidates([second])).rejects.toThrow(
      'already has incomplete Mint Issuance Attempt',
    );

    expect(secondTransport.requests).toHaveLength(0);
    expect((await repositories.mintOperationRepository.getById(second.id))?.state).toBe('pending');
  });

  it('emits committed state changes sequentially after releasing the mint lock', async () => {
    const lock = new MintScopedLock();
    const observed: string[] = [];
    eventBus.on('counter:updated', async () => {
      observed.push('counter');
    });
    eventBus.on('mint-op:executing', async () => {
      const release = await lock.acquire(mintUrl);
      observed.push('executing');
      release();
    });
    eventBus.on('proofs:saved', async () => {
      observed.push('proofs');
    });
    eventBus.on('mint-quote:updated', async () => {
      observed.push('quote');
    });
    eventBus.on('mint-op:finalized', async () => {
      observed.push('finalized');
    });
    const transport = new ScriptedMintIssuanceTransport([
      { kind: 'return', signatures: [validSignature()] },
    ]);

    await makeEngine(transport, { mintScopedLock: lock }).issueCandidates([pendingOperation()]);

    expect(observed).toEqual(['counter', 'executing', 'proofs', 'quote', 'finalized']);
  });
});
