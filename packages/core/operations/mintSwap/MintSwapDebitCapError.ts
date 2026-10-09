import { ProofValidationError } from '../../models/Error.ts';

export class MintSwapDebitCapError extends ProofValidationError {
  constructor() {
    super('Mint Swap source debit exceeds caller cap');
  }
}
