/**
 * Returns whether a mint quote's expiry is in the past.
 *
 * Some mints use `0` as a no-expiry sentinel, so it has the same semantics as
 * a missing or null expiry here.
 */
export function isMintQuoteExpired(quote: { expiry?: number | null }, now = Date.now()): boolean {
  return (
    quote.expiry !== null &&
    quote.expiry !== undefined &&
    quote.expiry !== 0 &&
    quote.expiry * 1000 <= now
  );
}
