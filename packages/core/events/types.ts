import type { Mint } from '../models/Mint';
import type { Keyset } from '../models/Keyset';
import type { Counter } from '../models/Counter';
import type { Proof } from '@cashu/cashu-ts';

export interface CoreEvents {
  'mint:added': { mint: Mint; keysets: Keyset[] };
  'mint:updated': { mint: Mint; keysets: Keyset[] };
  'counter:updated': Counter;
  'proofs:saved': { mintUrl: string; keysetId: string; proofs: Proof[] };
  'proofs:state-changed': {
    mintUrl: string;
    secrets: string[];
    state: 'inflight' | 'ready';
  };
  'proofs:deleted': { mintUrl: string; secrets: string[] };
}
