import type { MintKeys } from '@cashu/cashu-ts';
import type { CoreProof } from '../../types.ts';
import type { MintSwapOperation } from './MintSwapOperation.ts';
import type { ExecutingMeltOperation } from '../melt/MeltOperation.ts';
import type { ExecutingMintOperation } from '../mint/MintOperation.ts';
import type {
  ApplyMeltPaidResultInput,
  MeltNonPaymentEvidence,
} from '../melt/MeltTransitionTypes.ts';

export interface PrepareMintSwapInput {
  id: string;
  sourceKeys: MintKeys;
  destinationKeys: MintKeys;
  seed: Uint8Array;
  now: number;
}

export type BeginMintSwapSourceInput = Omit<PrepareMintSwapInput, 'seed'>;

export interface BeginMintSwapSourceResult {
  operation: MintSwapOperation;
  source?: ExecutingMeltOperation;
  inputProofs: CoreProof[];
  changed: boolean;
}

export interface ApplyMintSwapSourceInput {
  id: string;
  now: number;
  paid?: ApplyMeltPaidResultInput;
  nonPayment?: MeltNonPaymentEvidence;
}

export interface BeginMintSwapDestinationResult {
  operation: MintSwapOperation;
  destination?: ExecutingMintOperation;
  changed: boolean;
}
