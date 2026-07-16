import { MintOperationError } from '@cashu/cashu-ts';

/** A protocol error whose response included additional structured fields. */
export class StructuredMintOperationError extends MintOperationError {
  constructor(
    code: number,
    detail: string,
    readonly data: Readonly<Record<string, unknown>>,
  ) {
    super(code, detail);
    this.name = 'StructuredMintOperationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
