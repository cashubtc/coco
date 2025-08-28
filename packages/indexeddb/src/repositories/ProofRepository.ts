import type { Proof } from '@cashu/cashu-ts';
import type { ProofRepository, CoreProof } from 'coco-cashu-core';
import type { IdbDb, ProofRow } from '../lib/db.ts';

type ProofState = 'inflight' | 'ready';

export class IdbProofRepository implements ProofRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async saveProofs(mintUrl: string, proofs: Proof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    await (this.db as any).transaction('rw', ['coco_cashu_proofs'], async (_tx: unknown) => {
      for (const p of proofs) {
        const existing = await (this.db as any).table('coco_cashu_proofs').get([mintUrl, p.secret]);
        if (existing) {
          throw new Error(`Proof with secret already exists: ${p.secret}`);
        }
      }
      for (const p of proofs) {
        const row: ProofRow = {
          mintUrl,
          secret: p.secret,
          state: 'ready',
          proofJson: JSON.stringify(p),
          createdAt: now,
        };
        await (this.db as any).table('coco_cashu_proofs').put(row);
      }
    });
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+state]')
      .equals([mintUrl, 'ready'])
      .toArray()) as ProofRow[];
    return rows.map((r) => {
      const base = JSON.parse(r.proofJson) as Proof;
      return { ...base, mintUrl } satisfies CoreProof;
    });
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('state')
      .equals('ready')
      .toArray()) as ProofRow[];
    return rows.map((r) => {
      const base = JSON.parse(r.proofJson) as Proof;
      return { ...base, mintUrl: r.mintUrl } satisfies CoreProof;
    });
  }

  async setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await (this.db as any).transaction('rw', ['coco_cashu_proofs'], async (_tx: unknown) => {
      for (const s of secrets) {
        const existing = (await (this.db as any).table('coco_cashu_proofs').get([mintUrl, s])) as
          | ProofRow
          | undefined;
        if (existing) {
          await (this.db as any).table('coco_cashu_proofs').put({ ...existing, state } as ProofRow);
        }
      }
    });
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await (this.db as any).transaction('rw', ['coco_cashu_proofs'], async (_tx: unknown) => {
      for (const s of secrets) {
        await (this.db as any).table('coco_cashu_proofs').delete([mintUrl, s]);
      }
    });
  }
}
