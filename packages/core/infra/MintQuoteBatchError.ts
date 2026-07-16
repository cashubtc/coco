import { MintOperationError } from '../models/Error.ts';

/** A protocol rejection that carries an exact structured quote identity. */
export class QuoteSpecificMintOperationError extends MintOperationError {
  constructor(
    code: number,
    detail: string,
    readonly quoteId: string,
  ) {
    super(code, detail);
    this.name = 'QuoteSpecificMintOperationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
