import type { Token } from '@cashu/cashu-ts';
import type { MeltMethod, MeltOperation } from '@core/operations/melt';
import type {
  FailedMintOperation,
  FinalizedMintOperation,
  MintMethod,
  MintOperation,
} from '@core/operations/mint';
import type { MeltQuote } from '../models/MeltQuote';
import type { MintQuote } from '../models/MintQuote';
import type { UnitAmount } from '../amounts.ts';
import type { Counter } from '../models/Counter';
import type { HistoryEntry } from '../models/History';
import type { Keyset } from '../models/Keyset';
import type { Mint } from '../models/Mint';
import type { ReceiveOperation } from '../operations/receive/ReceiveOperation';
import type { SendOperation } from '../operations/send/SendOperation';
import type { MintSwapEventPayload } from '../models/OperationEventOutbox.ts';
import type { CoreProof, ProofState } from '../types';

export interface CoreEvents {
  'mint-swap-op:prepared': MintSwapEventPayload;
  'mint-swap-op:source-inflight': MintSwapEventPayload;
  'mint-swap-op:destination-funded': MintSwapEventPayload;
  'mint-swap-op:issuing': MintSwapEventPayload;
  'mint-swap-op:completed': MintSwapEventPayload;
  'mint-swap-op:cancelled': MintSwapEventPayload;
  'mint-swap-op:failed': MintSwapEventPayload;
  'mint-swap-op:needs-attention': MintSwapEventPayload;
  'mint-swap-op:delayed': MintSwapEventPayload;
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
  'proofs:reserved': {
    mintUrl: string;
    operationId: string;
    secrets: string[];
    amount: UnitAmount;
  };
  'proofs:released': { mintUrl: string; secrets: string[] };
  /** Emitted when send operation is prepared (proofs reserved) */
  'send:prepared': { mintUrl: string; operationId: string; operation: SendOperation };
  /** Emitted when send operation is executed (token created) */
  'send:pending': { mintUrl: string; operationId: string; operation: SendOperation; token: Token };
  /** Emitted when send operation is finalized (proofs confirmed spent) */
  'send:finalized': { mintUrl: string; operationId: string; operation: SendOperation };
  /** Emitted when send operation is rolled back */
  'send:rolled-back': { mintUrl: string; operationId: string; operation: SendOperation };
  /** Emitted when receive operation is prepared */
  'receive-op:prepared': {
    mintUrl: string;
    operationId: string;
    operation: ReceiveOperation;
  };
  /** Emitted when receive operation is finalized */
  'receive-op:finalized': {
    mintUrl: string;
    operationId: string;
    operation: ReceiveOperation;
  };
  /** Emitted when receive operation is rolled back */
  'receive-op:rolled-back': {
    mintUrl: string;
    operationId: string;
    operation: ReceiveOperation;
  };
  'history:updated': { mintUrl: string; entry: HistoryEntry };
  'melt-op:prepared': { mintUrl: string; operationId: string; operation: MeltOperation };
  'melt-op:pending': { mintUrl: string; operationId: string; operation: MeltOperation };
  'melt-op:finalized': { mintUrl: string; operationId: string; operation: MeltOperation };
  'melt-op:rolled-back': { mintUrl: string; operationId: string; operation: MeltOperation };
  'mint-op:pending': { mintUrl: string; operationId: string; operation: MintOperation };
  'mint-quote:updated': {
    mintUrl: string;
    method: MintMethod;
    quoteId: string;
    quote: MintQuote;
  };
  'melt-quote:updated': {
    mintUrl: string;
    method: MeltMethod;
    quoteId: string;
    quote: MeltQuote;
  };
  'mint-op:requeue': { mintUrl: string; operationId: string; operation: MintOperation };
  'mint-op:executing': { mintUrl: string; operationId: string; operation: MintOperation };
  'mint-op:finalized': { mintUrl: string; operationId: string; operation: FinalizedMintOperation };
  'mint-op:failed': { mintUrl: string; operationId: string; operation: FailedMintOperation };
  'subscriptions:paused': void;
  'subscriptions:resumed': void;
  'auth-session:updated': { mintUrl: string };
  'auth-session:deleted': { mintUrl: string };
  'auth-session:expired': { mintUrl: string };
}
