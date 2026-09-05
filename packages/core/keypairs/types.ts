import type { Keypair, KeypairPurpose } from '../models/Keypair.ts';

/** Synchronous derivation only: no I/O, persistence, or transaction creation. */
export type PurposeBoundKeyDeriver = (
  derivationIndex: number,
) => Pick<Keypair, 'publicKeyHex' | 'secretKey'>;

export interface AllocateKeypairCommand {
  purpose: KeypairPurpose;
  derive: PurposeBoundKeyDeriver;
}
