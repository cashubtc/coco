import type { Proof } from '@cashu/cashu-ts';

type ProofWitness = NonNullable<Proof['witness']>;

function normalizeWitnessValue(value: unknown): Proof['witness'] {
  if (!value) {
    return undefined;
  }

  let normalized = value;
  let lastString = typeof value === 'string' ? value : undefined;
  while (typeof normalized === 'string') {
    lastString = normalized;
    try {
      normalized = JSON.parse(normalized);
    } catch {
      return normalized;
    }
  }

  if (normalized && typeof normalized === 'object') {
    return normalized as ProofWitness;
  }

  return lastString;
}

export function normalizeProofWitness(witness: Proof['witness']): Proof['witness'] {
  return normalizeWitnessValue(witness);
}

export function stringifyProofWitness(witness: Proof['witness']): string | null {
  const normalized = normalizeProofWitness(witness);
  return normalized ? JSON.stringify(normalized) : null;
}

export function parsePersistedProofWitness(witnessJson: string | null): Proof['witness'] {
  return normalizeWitnessValue(witnessJson);
}
