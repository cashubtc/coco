import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';

import type { OutputDataCreator, OutputDataLike } from '../../index.ts';
import { deserializeOutput, serializeOutput } from '../../utils.ts';

describe('OutputData serialization', () => {
  it('accepts structural output data and preserves ephemeralE during reconstruction', () => {
    const output = {
      blindedMessage: {
        amount: Amount.from(21),
        id: 'keyset-1',
        B_: 'custom-blinded-message',
      },
      blindingFactor: 0xabcdn,
      secret: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      ephemeralE: 'custom-ephemeral-e',
      toProof: mock(() => {
        throw new Error('custom toProof must not survive reconstruction');
      }),
    } satisfies OutputDataLike;

    const serialized = serializeOutput(output);
    const reconstructed = deserializeOutput(serialized);

    expect(serialized.ephemeralE).toBe('custom-ephemeral-e');
    expect(reconstructed.ephemeralE).toBe('custom-ephemeral-e');
    expect(reconstructed.blindedMessage).toEqual(output.blindedMessage);
    expect(reconstructed.blindingFactor).toBe(output.blindingFactor);
    expect(reconstructed.secret).toEqual(output.secret);
    expect(reconstructed).not.toBe(output);
  });
});
