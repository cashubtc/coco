import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import {
  deserializeMintSwapOperation,
  serializeMintSwapOperation,
} from '../../operations/mintSwap/MintSwapSerialization.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';

describe('Mint Swap persistence serialization', () => {
  it('round-trips every V1 state and nested Amount as a decimal string', () => {
    for (const operation of Object.values(mintSwapFixtures())) {
      const json = serializeMintSwapOperation(operation);
      expect(json).not.toContain('destinationAmount":{"');
      expect(deserializeMintSwapOperation(json)).toEqual(operation);
    }
  });

  it('preserves Amount precision beyond JavaScript safe integers', () => {
    const operation = {
      ...mintSwapFixtures().preparing,
      destinationAmount: Amount.from('9007199254740993'),
      sourceDebitCap: Amount.from('9007199254740994'),
    };

    const hydrated = deserializeMintSwapOperation(serializeMintSwapOperation(operation));

    expect(hydrated.destinationAmount.toString()).toBe('9007199254740993');
    expect(hydrated.sourceDebitCap?.toString()).toBe('9007199254740994');
  });

  it('supports an omitted optional source debit cap and rejects malformed stored records', () => {
    const operation = { ...mintSwapFixtures().preparing, sourceDebitCap: undefined };
    expect(deserializeMintSwapOperation(serializeMintSwapOperation(operation))).toEqual(operation);
    expect(() => deserializeMintSwapOperation('{"schemaVersion":2}')).toThrow(TypeError);
  });
});
