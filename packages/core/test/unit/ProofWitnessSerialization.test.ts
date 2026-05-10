import { describe, expect, it } from 'bun:test';
import {
  normalizeProofWitness,
  parsePersistedProofWitness,
  stringifyProofWitness,
} from '../../repositories/ProofWitnessSerialization.ts';

describe('ProofWitnessSerialization', () => {
  const witness = {
    signatures: ['abc123'],
  };
  const witnessJson = JSON.stringify(witness);
  const doubleEncodedWitnessJson = JSON.stringify(witnessJson);

  it('stores object witnesses as one JSON object layer', () => {
    expect(stringifyProofWitness(witness)).toBe(witnessJson);
  });

  it('normalizes JSON string witnesses before storing', () => {
    expect(stringifyProofWitness(witnessJson)).toBe(witnessJson);
  });

  it('normalizes legacy double-encoded persisted witnesses', () => {
    expect(parsePersistedProofWitness(doubleEncodedWitnessJson)).toEqual(witness);
  });

  it('leaves non-JSON string witnesses round-trippable', () => {
    expect(stringifyProofWitness('mock-signature')).toBe('"mock-signature"');
    expect(parsePersistedProofWitness('"mock-signature"')).toBe('mock-signature');
  });

  it('normalizes nested JSON string witnesses', () => {
    expect(normalizeProofWitness(doubleEncodedWitnessJson)).toEqual(witness);
  });
});
