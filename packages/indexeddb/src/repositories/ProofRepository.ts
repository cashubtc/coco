import type { ProofRepository, CoreProof, ProofState } from 'coco-cashu-core';
import type { IdbDb, ProofRow } from '../lib/db.ts';

function rowToProof(r: ProofRow): CoreProof {
  const base = {
    id: r.id,
    amount: r.amount,
    secret: r.secret,
    C: r.C,
    ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
    ...(r.witness ? { witness: JSON.parse(r.witness) } : {}),
  };
  return {
    ...base,
    mintUrl: r.mintUrl,
    state: r.state,
    ...(r.usedByOperationId ? { usedByOperationId: r.usedByOperationId } : {}),
    ...(r.createdByOperationId ? { createdByOperationId: r.createdByOperationId } : {}),
  };
}

export class IdbProofRepository implements ProofRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const p of proofs) {
        const existing = await table.get([mintUrl, p.secret]);
        if (existing) {
          throw new Error(`Proof with secret already exists: ${p.secret}`);
        }
      }
      for (const p of proofs) {
        const row: ProofRow = {
          mintUrl,
          id: p.id,
          amount: p.amount,
          secret: p.secret,
          C: p.C,
          dleqJson: p.dleq ? JSON.stringify(p.dleq) : null,
          witness: p.witness ? JSON.stringify(p.witness) : null,
          state: p.state,
          createdAt: now,
          usedByOperationId: p.usedByOperationId ?? null,
          createdByOperationId: p.createdByOperationId ?? null,
        };
        await table.put(row);
      }
    });
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+state]')
      .equals([mintUrl, 'ready'])
      .toArray()) as ProofRow[];
    return rows.map(rowToProof);
  }

  async getInflightProofs(mintUrls?: string[]): Promise<CoreProof[]> {
    if (!mintUrls || mintUrls.length === 0) {
      const rows = (await (this.db as any)
        .table('coco_cashu_proofs')
        .where('state')
        .equals('inflight')
        .toArray()) as ProofRow[];
      return rows.map(rowToProof);
    }
    const mintUrlList = mintUrls.map((url) => url.trim()).filter((url) => url.length > 0);
    if (mintUrlList.length === 0) return [];
    const uniqueMintUrls = Array.from(new Set(mintUrlList));
    const keys = uniqueMintUrls.map((mintUrl) => [mintUrl, 'inflight'] as [string, string]);
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+state]')
      .anyOf(keys)
      .toArray()) as ProofRow[];
    return rows.map(rowToProof);
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('state')
      .equals('ready')
      .toArray()) as ProofRow[];
    return rows.map(rowToProof);
  }

  async getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+id+state]')
      .equals([mintUrl, keysetId, 'ready'])
      .toArray()) as ProofRow[];
    return rows.map(rowToProof);
  }

  async getReadyProofsByKeysetIds(mintUrl: string, keysetIds: string[]): Promise<CoreProof[]> {
    if (!keysetIds || keysetIds.length === 0) return [];
    const keys = keysetIds.map((id) => [mintUrl, id, 'ready'] as [string, string, string]);
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+id+state]')
      .anyOf(keys)
      .toArray()) as ProofRow[];
    return rows.map(rowToProof);
  }

  async setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const s of secrets) {
        const existing = (await table.get([mintUrl, s])) as ProofRow | undefined;
        if (existing) {
          await table.put({ ...existing, state } as ProofRow);
        }
      }
    });
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const s of secrets) {
        await table.delete([mintUrl, s]);
      }
    });
  }

  async wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      const rows = (await table
        .where('[mintUrl+id]')
        .equals([mintUrl, keysetId])
        .toArray()) as ProofRow[];
      for (const r of rows) {
        await table.delete([mintUrl, r.secret]);
      }
    });
  }

  async reserveProofs(mintUrl: string, secrets: string[], operationId: string): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      // Pre-check: all proofs must exist, be ready, and not already reserved
      for (const secret of secrets) {
        const row = (await table.get([mintUrl, secret])) as ProofRow | undefined;
        if (!row) {
          throw new Error(`Proof with secret not found: ${secret}`);
        }
        if (row.state !== 'ready') {
          throw new Error(`Proof is not ready, cannot reserve: ${secret}`);
        }
        if (row.usedByOperationId) {
          throw new Error(
            `Proof already reserved by operation ${row.usedByOperationId}: ${secret}`,
          );
        }
      }
      // Apply reservation
      for (const secret of secrets) {
        const existing = (await table.get([mintUrl, secret])) as ProofRow;
        await table.put({ ...existing, usedByOperationId: operationId });
      }
    });
  }

  async releaseProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const secret of secrets) {
        const existing = (await table.get([mintUrl, secret])) as ProofRow | undefined;
        if (existing) {
          const { usedByOperationId: _, ...rest } = existing;
          await table.put({ ...rest, usedByOperationId: null } as ProofRow);
        }
      }
    });
  }

  async setCreatedByOperation(
    mintUrl: string,
    secrets: string[],
    operationId: string,
  ): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const secret of secrets) {
        const existing = (await table.get([mintUrl, secret])) as ProofRow | undefined;
        if (existing) {
          await table.put({ ...existing, createdByOperationId: operationId });
        }
      }
    });
  }

  async getProofBySecret(mintUrl: string, secret: string): Promise<CoreProof | null> {
    const row = (await (this.db as any).table('coco_cashu_proofs').get([mintUrl, secret])) as
      | ProofRow
      | undefined;
    return row ? rowToProof(row) : null;
  }

  async getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]> {
    // Note: IndexedDB doesn't support OR queries easily, so we do two queries
    const byUsed = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('usedByOperationId')
      .equals(operationId)
      .toArray()) as ProofRow[];

    const byCreated = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('createdByOperationId')
      .equals(operationId)
      .toArray()) as ProofRow[];

    // Combine and deduplicate by [mintUrl, secret]
    const seen = new Set<string>();
    const results: CoreProof[] = [];

    for (const row of [...byUsed, ...byCreated]) {
      if (row.mintUrl !== mintUrl) continue;
      const key = `${row.mintUrl}::${row.secret}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(rowToProof(row));
      }
    }

    return results;
  }

  async getAvailableProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+state]')
      .equals([mintUrl, 'ready'])
      .toArray()) as ProofRow[];
    return rows.filter((r) => !r.usedByOperationId).map(rowToProof);
  }

  async getReservedProofs(): Promise<CoreProof[]> {
    // Get all proofs with usedByOperationId set that are still in ready state
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('state')
      .equals('ready')
      .toArray()) as ProofRow[];
    return rows.filter((r) => r.usedByOperationId).map(rowToProof);
  }
}
