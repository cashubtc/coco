import {
  StaleKeysetError,
  MintOperationError,
  type OutputDataLike,
  type Wallet,
} from '@cashu/cashu-ts';
import { ProofValidationError } from '../models/Error.ts';

/** Keep submission and unblinding bound to the persisted allocation, even after rotation. */
export function getOutputKeysetId(outputs: readonly OutputDataLike[]): string {
  const id = outputs[0]?.blindedMessage.id;
  if (!id || outputs.some((output) => output.blindedMessage.id !== id)) {
    throw new ProofValidationError('Persisted outputs must specify a single non-empty keyset id');
  }
  return id;
}

/** A locally known inactive output keyset is a pre-submission rejection, never a new allocation. */
export function assertOutputKeysetActive(wallet: Wallet, keysetId: string): void {
  if (!wallet.keyChain.getKeyset(keysetId).isActive) throw new StaleKeysetError(false);
}

/** The direct mint adapter and cashu-ts Wallet expose the same rejection in different wrappers. */
export function isKeysetRejection(error: unknown): error is StaleKeysetError | MintOperationError {
  return (
    error instanceof StaleKeysetError ||
    (error instanceof MintOperationError && [12001, 12002, 12003].includes(error.code))
  );
}
