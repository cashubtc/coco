import { testMintInfo } from '../fixtures/MintMetadata.ts';
import { Amount, type OutputDataLike } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler.ts';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler.ts';
import type { PrepareContext } from '../../operations/send/SendMethodHandler.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

const mintUrl = 'https://mint.test';
const pubkey = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const common = {
  id: 'send',
  state: 'init' as const,
  mintUrl,
  amount: Amount.from(10),
  unit: 'sat',
  createdAt: 100,
  updatedAt: 100,
};
const keys = { id: 'keyset', unit: 'sat', keys: {} };

describe('Send method policies', () => {
  it('allows default reclaim and selects exact or forced swap preparation', () => {
    const handler = new DefaultSendHandler();
    const ctx = {
      operation: { ...common, method: 'default', methodData: {} },
      activeKeys: keys,
      mintInfo: { ...testMintInfo, nuts: { ...testMintInfo.nuts, '11': undefined } },
      outputDataCreator: makeOutputDataCreator(),
    } satisfies PrepareContext<'default'>;
    expect(handler.canReclaim).toBe(true);
    expect(handler.prepare(ctx)).toEqual({ forceSwap: false });
    expect(
      handler.prepare({ ...ctx, operation: { ...ctx.operation, methodData: { forceSwap: true } } }),
    ).toEqual({ forceSwap: true });
  });

  it('fixes P2PK outputs synchronously from advertised capabilities and rejects reclaim', () => {
    const output = {
      blindedMessage: { id: 'keyset', amount: Amount.from(10), B_: 'B' },
      blindingFactor: 1n,
      secret: new Uint8Array([1]),
      toProof: () => {
        throw new Error('not used');
      },
    } satisfies OutputDataLike;
    const createP2PKData = mock(() => [output]);
    const handler = new P2pkSendHandler();
    const ctx = {
      operation: { ...common, method: 'p2pk', methodData: { pubkey } },
      activeKeys: keys,
      mintInfo: testMintInfo,
      outputDataCreator: makeOutputDataCreator({ createP2PKData }),
    } satisfies PrepareContext<'p2pk'>;
    expect(handler.prepare(ctx)).toEqual({ forceSwap: true, fixedSendOutputs: [output] });
    expect(createP2PKData).toHaveBeenCalledWith(
      { kind: 'P2PK', data: pubkey },
      Amount.from(10),
      keys,
    );
    expect(handler.canReclaim).toBe(false);
  });

  it('rejects unsupported P2PK and HTLC data before deriving outputs', () => {
    const handler = new P2pkSendHandler();
    const createP2PKData = mock(() => []);
    const ctx = {
      operation: { ...common, method: 'p2pk', methodData: { pubkey } },
      activeKeys: keys,
      mintInfo: { ...testMintInfo, nuts: { ...testMintInfo.nuts, '11': undefined } },
      outputDataCreator: makeOutputDataCreator({ createP2PKData }),
    } satisfies PrepareContext<'p2pk'>;
    expect(() => handler.prepare(ctx)).toThrow('NUT-11 support is required');
    expect(() =>
      handler.prepare({
        ...ctx,
        operation: {
          ...ctx.operation,
          methodData: { options: { pubkey, hashlock: 'hash' } as never },
        },
      }),
    ).toThrow('P2PK send does not support hashlock/HTLC options');
    expect(createP2PKData).not.toHaveBeenCalled();
  });
});
