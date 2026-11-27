import { StaleKeysetError } from '@cashu/cashu-ts';
import { MintOperationError } from '../models/Error.ts';

/**
 * cashu-ts wraps a mint's keyset rejection (any NUT-00 code from 12000 to 12999) in
 * `StaleKeysetError`, with the mint's error as `cause`. Coco classifies outcomes by the mint's own
 * error, so hand that back to the caller. Use it at every call that completes a swap, a mint or a
 * batch mint.
 */
export function unwrapKeysetRejection<T>(request: Promise<T>): Promise<T> {
  return request.catch((error: unknown) => {
    throw error instanceof StaleKeysetError && error.cause !== undefined ? error.cause : error;
  });
}

/** Whether a mint rejected a request for its keyset: NUT-00 reserves 12000 to 12999 for this. */
export function isKeysetRejection(error: unknown): error is MintOperationError {
  return (
    error instanceof MintOperationError &&
    Number.isFinite(error.code) &&
    error.code >= 12000 &&
    error.code < 13000
  );
}
