import { StaleKeysetError } from '@cashu/cashu-ts';

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
