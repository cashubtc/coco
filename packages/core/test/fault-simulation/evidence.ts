/**
 * Read-only observation facilities that corroborate Wallet outcomes.
 *
 * Wallet stores are opened read-only and the mint is probed directly, bypassing fault gateways.
 * Proof secrets are converted to their public `Y` points immediately; callers receive secrets only
 * so they can register them with the trace redaction check.
 */
import { getDecodedToken, hashToCurve } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { MintProofState, ObservedProof, StoredProof } from './accounting.ts';

const encoder = new TextEncoder();

export function proofY(secret: string): string {
  return hashToCurve(encoder.encode(secret)).toHex(true);
}

interface ProofRow {
  amount: string;
  id: string;
  unit: string;
  secret: string;
  state: StoredProof['storeState'];
  usedByOperationId: string | null;
}

/** Proofs from a Wallet store, without mint states. Missing stores yield no proofs. */
export function readStoredProofs(
  dbPath: string,
  unit: string,
): { proofs: Omit<StoredProof, 'mintState'>[]; secrets: string[] } {
  if (!existsSync(dbPath)) return { proofs: [], secrets: [] };
  const database = new Database(dbPath, { readonly: true });
  try {
    const rows = database
      .query(
        'SELECT amount, id, unit, secret, state, usedByOperationId FROM coco_cashu_proofs WHERE unit = ?',
      )
      .all(unit) as ProofRow[];
    return {
      proofs: rows.map((row) => ({
        y: proofY(row.secret),
        amount: Number(row.amount),
        keysetId: row.id,
        storeState: row.state,
        ...(row.usedByOperationId ? { usedByOperationId: row.usedByOperationId } : {}),
      })),
      secrets: rows.map((row) => row.secret),
    };
  } finally {
    database.close();
  }
}

/** Persisted Receive operation state, observed without a Coco Session. */
export function readPersistedReceiveState(dbPath: string, operationId: string): string | undefined {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = database
      .query('SELECT state FROM coco_cashu_receive_operations WHERE id = ?')
      .get(operationId) as { state: string } | null;
    return row?.state;
  } finally {
    database.close();
  }
}

/** Direct, read-only mint queries for the harness. */
export class MintProbe {
  constructor(private readonly directUrl: string) {}

  async keysets(): Promise<{ id: string; unit: string; input_fee_ppk?: number }[]> {
    const response = await fetch(`${this.directUrl}/v1/keysets`);
    if (!response.ok) throw new Error(`Mint keysets returned ${response.status}`);
    return ((await response.json()) as { keysets: never[] }).keysets;
  }

  async keysetFeePpk(unit: string): Promise<Record<string, number>> {
    const fees: Record<string, number> = {};
    for (const keyset of await this.keysets()) {
      if (keyset.unit === unit) fees[keyset.id] = keyset.input_fee_ppk ?? 0;
    }
    return fees;
  }

  /** NUT-07 states by `Y`. A `Y` the mint did not report is absent, which callers keep unresolved. */
  async proofStates(ys: string[]): Promise<Map<string, MintProofState>> {
    const states = new Map<string, MintProofState>();
    const unique = [...new Set(ys)];
    for (let index = 0; index < unique.length; index += 100) {
      const response = await fetch(`${this.directUrl}/v1/checkstate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Ys: unique.slice(index, index + 100) }),
      });
      if (!response.ok) throw new Error(`Mint checkstate returned ${response.status}`);
      const body = (await response.json()) as { states: { Y: string; state: MintProofState }[] };
      for (const state of body.states) states.set(state.Y, state.state);
    }
    return states;
  }
}

/** Decodes a token independently of the sending Wallet. */
export function decodeTokenInputs(
  token: string,
  keysetIds: string[],
): { inputs: Omit<ObservedProof, 'mintState'>[]; secrets: string[] } {
  const decoded = getDecodedToken(token, keysetIds);
  return {
    inputs: decoded.proofs.map((proof) => ({
      y: proofY(proof.secret),
      amount: Number(proof.amount.toString()),
      keysetId: proof.id,
    })),
    secrets: decoded.proofs.map((proof) => proof.secret),
  };
}
