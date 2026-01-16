import type { Mint } from '../models/Mint';
import type { Keyset } from '../models/Keyset';
import type { Counter } from '../models/Counter';
import type {
  MeltQuoteResponse,
  MeltQuoteState,
  MintQuoteResponse,
  MintQuoteState,
  Token,
} from '@cashu/cashu-ts';
import type { CoreProof, ProofState } from '../types';
import type { HistoryEntry } from '../models/History';
import type { SendOperation } from '../operations/send/SendOperation';
import type { MeltOperation } from '@core/operations/melt';

export interface CoreEvents {
  'mint:added': { mint: Mint; keysets: Keyset[] };
  'mint:updated': { mint: Mint; keysets: Keyset[] };
  'mint:trusted': { mintUrl: string };
  'mint:untrusted': { mintUrl: string };
  'counter:updated': Counter;
  'proofs:saved': { mintUrl: string; keysetId: string; proofs: CoreProof[] };
  'proofs:state-changed': {
    mintUrl: string;
    secrets: string[];
    state: ProofState;
  };
  'proofs:deleted': { mintUrl: string; secrets: string[] };
  'proofs:wiped': { mintUrl: string; keysetId: string };
  'proofs:reserved': { mintUrl: string; operationId: string; secrets: string[]; amount: number };
  'proofs:released': { mintUrl: string; secrets: string[] };
  'mint-quote:state-changed': { mintUrl: string; quoteId: string; state: MintQuoteState };
  'mint-quote:created': { mintUrl: string; quoteId: string; quote: MintQuoteResponse };
  'mint-quote:added': {
    mintUrl: string;
    quoteId: string;
    quote: MintQuoteResponse;
  };
  'mint-quote:requeue': { mintUrl: string; quoteId: string };
  'mint-quote:redeemed': { mintUrl: string; quoteId: string; quote: MintQuoteResponse };
  'melt-quote:created': { mintUrl: string; quoteId: string; quote: MeltQuoteResponse };
  'melt-quote:state-changed': { mintUrl: string; quoteId: string; state: MeltQuoteState };
  'melt-quote:paid': { mintUrl: string; quoteId: string; quote: MeltQuoteResponse };
  /** Emitted when send operation is prepared (proofs reserved) */
  'send:prepared': { mintUrl: string; operationId: string; operation: SendOperation };
  /** Emitted when send operation is executed (token created) */
  'send:pending': { mintUrl: string; operationId: string; operation: SendOperation; token: Token };
  /** Emitted when send operation is finalized (proofs confirmed spent) */
  'send:finalized': { mintUrl: string; operationId: string; operation: SendOperation };
  /** Emitted when send operation is rolled back */
  'send:rolled-back': { mintUrl: string; operationId: string; operation: SendOperation };
  'receive:created': { mintUrl: string; token: Token };
  'history:updated': { mintUrl: string; entry: HistoryEntry };
  'melt-op:prepared': { mintUrl: string; operationId: string; operation: MeltOperation };
  'melt-op:pending': { mintUrl: string; operationId: string; operation: MeltOperation };
  'melt-op:finalized': { mintUrl: string; operationId: string; operation: MeltOperation };
  'melt-op:rolled-back': { mintUrl: string; operationId: string; operation: MeltOperation };
}
