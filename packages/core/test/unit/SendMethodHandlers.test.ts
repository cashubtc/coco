import { Amount, type OutputDataLike, type Token } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler.ts';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler.ts';
import type {
  ExecuteContext,
  PrepareContext,
  RecoverExecutingContext,
  RollbackContext,
} from '../../operations/send/SendMethodHandler.ts';
import type {
  ExecutingSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
} from '../../operations/send/SendOperation.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

const mintUrl = 'https://mint.test';
const pubkey = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const token = { mint: mintUrl, unit: 'sat', proofs: [] } satisfies Token;

function init(
  method: 'default' | 'p2pk',
  methodData: InitSendOperation['methodData'],
): InitSendOperation {
  return {
    id: `${method}-send`,
    state: 'init',
    mintUrl,
    amount: Amount.from(10),
    unit: 'sat',
    method,
    methodData,
    createdAt: 100,
    updatedAt: 100,
  } as InitSendOperation;
}

function prepared(method: 'default' | 'p2pk', needsSwap: boolean): PreparedSendOperation {
  return {
    ...init(method, method === 'default' ? {} : { pubkey }),
    state: 'prepared',
    revision: 0,
    needsSwap,
    fee: Amount.zero(),
    inputAmount: Amount.from(10),
    inputProofSecrets: ['input'],
  } as PreparedSendOperation;
}

function pending(method: 'default' | 'p2pk'): PendingSendOperation {
  return { ...prepared(method, method === 'p2pk'), state: 'pending', token };
}

describe('Send method handler lifecycle policies', () => {
  it('lets the default handler choose exact execution and pending reclaim', async () => {
    const handler = new DefaultSendHandler();
    const executeExact = mock(async () => ({ operation: pending('default'), token }));
    const executeSwap = mock(async () => ({ operation: pending('default'), token }));

    await handler.execute({
      operation: prepared('default', false),
      executeExact,
      executeSwap,
    });
    expect(executeExact).toHaveBeenCalledTimes(1);
    expect(executeSwap).not.toHaveBeenCalled();

    const reclaimPendingDefault = mock(async () => {});
    await handler.rollback({
      operation: pending('default'),
      reason: 'reclaim',
      cancelPrepared: mock(async () => {}),
      reclaimPendingDefault,
    });
    expect(reclaimPendingDefault).toHaveBeenCalledTimes(1);
  });

  it('passes default force-swap policy to the authoritative prepare callback', async () => {
    const handler = new DefaultSendHandler();
    const commit = mock(async () => ({ operation: prepared('default', true) }) as never);
    const ctx = {
      operation: init('default', { forceSwap: true }),
      activeKeys: { id: 'keyset', unit: 'sat', keys: {} },
      outputDataCreator: makeOutputDataCreator(),
      assertNutSupported: mock(async () => {}),
      commit,
    } as PrepareContext<'default'>;

    await handler.prepare(ctx);

    expect(commit).toHaveBeenCalledWith({ forceSwap: true });
  });

  it('keeps P2PK preparation, execution, and rollback policy in the P2PK handler', async () => {
    const fixedOutput = {
      blindedMessage: { id: 'keyset', amount: Amount.from(10), B_: 'B' },
      blindingFactor: 1n,
      secret: new Uint8Array([1]),
      toProof: () => {
        throw new Error('not used');
      },
    } satisfies OutputDataLike;
    const createP2PKData = mock(() => [fixedOutput]);
    const commit = mock(async () => ({ operation: prepared('p2pk', true) }) as never);
    const assertNutSupported = mock(async () => {});
    const handler = new P2pkSendHandler();
    const ctx = {
      operation: init('p2pk', { pubkey }),
      activeKeys: { id: 'keyset', unit: 'sat', keys: {} },
      outputDataCreator: makeOutputDataCreator({ createP2PKData }),
      assertNutSupported,
      commit,
    } as PrepareContext<'p2pk'>;

    await handler.prepare(ctx);
    expect(assertNutSupported).toHaveBeenCalledWith(11, 'P2PK send');
    expect(createP2PKData).toHaveBeenCalledWith(
      { kind: 'P2PK', data: pubkey },
      Amount.from(10),
      ctx.activeKeys,
    );
    expect(commit).toHaveBeenCalledWith({ forceSwap: true, fixedSendOutputs: [fixedOutput] });

    const executeSwap = mock(async () => ({ operation: pending('p2pk'), token }));
    await handler.execute({
      operation: prepared('p2pk', true),
      executeExact: mock(async () => ({ operation: pending('p2pk'), token })),
      executeSwap,
    } satisfies ExecuteContext);
    expect(executeSwap).toHaveBeenCalledTimes(1);

    const cancelPrepared = mock(async () => {});
    await handler.rollback({
      operation: prepared('p2pk', true),
      reason: 'cancel',
      cancelPrepared,
      reclaimPendingDefault: mock(async () => {}),
    });
    expect(cancelPrepared).toHaveBeenCalledTimes(1);

    expect(() =>
      handler.rollback({
        operation: pending('p2pk'),
        reason: 'not possible',
        cancelPrepared: mock(async () => {}),
        reclaimPendingDefault: mock(async () => {}),
      } satisfies RollbackContext),
    ).toThrow('can not be rolled back');
  });

  it('rejects unsupported P2PK method data before remote preflight or persistence', async () => {
    const handler = new P2pkSendHandler();
    const assertNutSupported = mock(async () => {});
    const commit = mock(async () => ({ operation: prepared('p2pk', true) }) as never);
    const ctx = {
      operation: init('p2pk', {
        options: { pubkey, hashlock: 'hash' } as never,
      }),
      activeKeys: { id: 'keyset', unit: 'sat', keys: {} },
      outputDataCreator: makeOutputDataCreator(),
      assertNutSupported,
      commit,
    } as PrepareContext<'p2pk'>;

    await expect(handler.prepare(ctx)).rejects.toThrow(
      'P2PK send does not support hashlock/HTLC options',
    );
    expect(assertNutSupported).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('dispatches executing recovery through either registered handler', async () => {
    const recoverPersistedSend = mock(async () => {});
    const operation = {
      ...prepared('default', true),
      state: 'executing',
    } as ExecutingSendOperation;
    const ctx = { operation, recoverPersistedSend } satisfies RecoverExecutingContext;

    await new DefaultSendHandler().recoverExecuting(ctx);
    await new P2pkSendHandler().recoverExecuting({
      ...ctx,
      operation: { ...operation, method: 'p2pk', methodData: { pubkey } },
    });

    expect(recoverPersistedSend).toHaveBeenCalledTimes(2);
  });
});
